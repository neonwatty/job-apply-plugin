import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 8;
const CHECKPOINT = /^[0-9]{4}-(?:application-opened|step-advanced|validation-observed|review-reached|final-action-boundary)$/;
const CHECKPOINT_FILES = ['checkpoint.json', 'controls.json', 'page.html', 'page.png'];
const READ = 0, CREATE = 1, APPEND = 2;
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, S_IFMT, S_IFREG, S_IFDIR, S_IFLNK } = constants;

export class BrokerError extends Error {}

function directName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name) || name.length > 128 ||
      name === '.' || name === '..' || name.endsWith('\n')) throw new BrokerError('unsafe-path');
  return name;
}

function parts(path, allowRoot = false) {
  if (allowRoot && path === '') return [];
  if (typeof path !== 'string' || path.length > 512) throw new BrokerError('unsafe-path');
  const parts = path.split('/');
  if (parts.length > MAX_DEPTH) throw new BrokerError('unsafe-path');
  return parts.map(directName);
}

function filesystemError(error, fallback) {
  if (error instanceof BrokerError) return error;
  if (error.code === 'EEXIST') return new BrokerError('destination-exists');
  if (error.code === 'EUNSAFEPATH') return new BrokerError('unsafe-path');
  if (error.code === 'EENTRYBUDGET') return new BrokerError('session-budget');
  return new BrokerError(fallback);
}

function privateDirectory(info, exact = true) {
  return info.isDirectory() && info.uid === process.getuid() &&
    (exact ? (info.mode & 0o777) === 0o700 : (info.mode & 0o077) === 0);
}

function regular(metadata) {
  return (metadata.mode & S_IFMT) === S_IFREG;
}

function withFd(fd, action) {
  try { return action(fd); }
  finally { closeSync(fd); }
}

function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written === 0) throw new BrokerError('write-failed');
    offset += written;
  }
}

export function removeControl(directory, fd) {
  if (!privateDirectory(fstatSync(fd))) return;
  try {
    const info = directory.inspect(fd, 'control.json');
    if (regular(info) || (info.mode & S_IFMT) === S_IFLNK) directory.unlink(fd, 'control.json', false);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export class SessionBroker {
  #parentFd;
  #rootFd;
  #directory;

  constructor(root, directory) {
    this.#directory = directory;
    if (!isAbsolute(root) || basename(dirname(root)) !== '.qa-private') throw new BrokerError('unsafe-root');
    const name = directName(basename(root));
    try {
      this.#parentFd = openSync(dirname(root), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (!privateDirectory(fstatSync(this.#parentFd))) throw new BrokerError('unsafe-root');
      try { directory.mkdir(this.#parentFd, name); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      this.#rootFd = directory.openDirectory(this.#parentFd, name);
      if (!privateDirectory(fstatSync(this.#rootFd))) throw new BrokerError('unsafe-root');
    } catch {
      this.close();
      throw new BrokerError('unsafe-root');
    }
  }

  get rootFd() { return this.#rootFd; }

  clearControl() { removeControl(this.#directory, this.#rootFd); }

  close() {
    if (this.#rootFd !== undefined) closeSync(this.#rootFd);
    if (this.#parentFd !== undefined) closeSync(this.#parentFd);
    this.#rootFd = this.#parentFd = undefined;
  }

  #ensureOpen() {
    if (this.#rootFd === undefined) throw new BrokerError('broker-closed');
    if (!privateDirectory(fstatSync(this.#parentFd), false) || !privateDirectory(fstatSync(this.#rootFd))) {
      throw new BrokerError('root-changed');
    }
  }

  #names(fd, limit = MAX_ENTRIES) {
    return this.#directory.list(fd, limit).map(bytes => {
      const name = bytes.toString('utf8');
      if (!Buffer.from(name).equals(bytes)) throw new BrokerError('unsafe-path');
      return name;
    }).sort();
  }

  #withDirectory(segments, action) {
    this.#ensureOpen();
    const visit = (fd, index) => {
      if (index === segments.length) return action(fd);
      let child;
      try { child = this.#directory.openDirectory(fd, segments[index]); }
      catch { throw new BrokerError('unsafe-path'); }
      return withFd(child, () => visit(child, index + 1));
    };
    return visit(this.#rootFd, 0);
  }

  #entry(path, operation) {
    const segments = parts(path), name = segments.pop();
    return this.#withDirectory(segments, parent => operation(parent, name));
  }

  mkdir(path) {
    this.#entry(path, (parent, name) => {
      try {
        this.#directory.mkdir(parent, name);
        withFd(this.#directory.openDirectory(parent, name), fd => {
          if (!privateDirectory(fstatSync(fd))) throw new BrokerError('unsafe-path');
        });
      } catch (error) { throw filesystemError(error, 'mkdir-failed'); }
    });
  }

  budget() {
    this.#ensureOpen();
    let entries = 0, bytes = 0;
    const visit = (fd, depth) => {
      if (depth > MAX_DEPTH) throw new BrokerError('session-budget');
      for (const name of this.#names(fd, MAX_ENTRIES - entries)) {
        if (++entries > MAX_ENTRIES) throw new BrokerError('session-budget');
        const metadata = this.#directory.inspect(fd, name);
        if ((metadata.mode & S_IFMT) === S_IFDIR) {
          withFd(this.#directory.openDirectory(fd, name), child => visit(child, depth + 1));
        } else if (regular(metadata)) {
          bytes += metadata.size;
        } else {
          throw new BrokerError('unsafe-path');
        }
      }
    };
    try { visit(this.#rootFd, 0); }
    catch (error) { throw filesystemError(error, 'unsafe-path'); }
    return { entries, bytes };
  }

  #checkBudget(size, replaced = 0) {
    if (size > MAX_FILE_BYTES) throw new BrokerError('file-budget');
    if (this.budget().bytes - replaced + size > MAX_SESSION_BYTES) throw new BrokerError('session-budget');
  }

  #writePrivate(parent, name, data, created) {
    withFd(this.#directory.openFile(parent, name, CREATE), fd => {
      created?.();
      const info = fstatSync(fd);
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new BrokerError('unsafe-path');
      writeAll(fd, data);
      fsyncSync(fd);
    });
  }

  writeExclusive(path, data) {
    this.#checkBudget(data.length);
    this.#entry(path, (parent, name) => {
      try { this.#writePrivate(parent, name, data); }
      catch (error) { throw filesystemError(error, 'write-failed'); }
    });
  }

  append(path, data) {
    this.#entry(path, (parent, name) => {
      try {
        withFd(this.#directory.openFile(parent, name, APPEND), fd => {
          const info = fstatSync(fd);
          if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid() || info.nlink !== 1) {
            throw new BrokerError('unsafe-path');
          }
          this.#checkBudget(info.size + data.length, info.size);
          writeAll(fd, data);
        });
      } catch (error) { throw filesystemError(error, 'write-failed'); }
    });
  }

  atomicReplace(path, data) {
    this.#entry(path, (parent, name) => {
      const temporary = '.tmp-write-' + randomBytes(16).toString('hex');
      let created = false;
      try {
        let bytes = 0;
        try {
          const previous = this.#directory.inspect(parent, name);
          if (!regular(previous)) throw new BrokerError('unsafe-path');
          bytes = previous.size;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.#checkBudget(data.length, bytes);
        this.#writePrivate(parent, temporary, data, () => { created = true; });
        this.#directory.rename(parent, temporary, parent, name, false);
      } catch (error) {
        if (created) {
          try { this.#directory.unlink(parent, temporary, false); }
          catch { /* Preserve the original value-free failure. */ }
        }
        throw filesystemError(error, 'write-failed');
      }
    });
  }

  renameNoReplace(source, destination) {
    this.#entry(source, (sourceFd, sourceName) => this.#entry(destination, (destinationFd, destinationName) => {
      try { this.#directory.rename(sourceFd, sourceName, destinationFd, destinationName, true); }
      catch (error) {
        if (error.code === 'ENOSYS') throw new BrokerError('exclusive-rename-unsupported');
        throw filesystemError(error, 'rename-failed');
      }
    }));
  }

  removeTree(path) {
    this.#entry(path, (parent, name) => {
      const remove = (fd, entry, depth) => {
        if (depth > MAX_DEPTH) throw new BrokerError('unsafe-path');
        const metadata = this.#directory.inspect(fd, entry);
        if (regular(metadata)) {
          this.#directory.unlink(fd, entry, false);
          return;
        }
        if ((metadata.mode & S_IFMT) !== S_IFDIR) throw new BrokerError('unsafe-path');
        withFd(this.#directory.openDirectory(fd, entry), child => {
          for (const leaf of this.#names(child)) remove(child, leaf, depth + 1);
        });
        this.#directory.unlink(fd, entry, true);
      };
      try { remove(parent, name, 0); }
      catch (error) { if (error.code !== 'ENOENT') throw filesystemError(error, 'remove-failed'); }
    });
  }

  #hash(fd, name) {
    return withFd(this.#directory.openFile(fd, name, READ), opened => {
      const data = fstatSync(opened);
      if (!data.isFile() || data.size > MAX_FILE_BYTES) throw new BrokerError('file-budget');
      const buffer = Buffer.alloc(64 * 1024);
      const hash = createHash('sha256');
      let read, total = 0;
      while ((read = readSync(opened, buffer, 0, buffer.length, null)) > 0) {
        total += read;
        if (total > MAX_FILE_BYTES) throw new BrokerError('file-budget');
        hash.update(buffer.subarray(0, read));
      }
      return hash.digest('hex');
    });
  }

  hashSourceFiles() {
    this.budget();
    const result = {};
    for (const name of ['events.jsonl', 'recording-summary.json']) {
      try { result[name] = this.#hash(this.#rootFd, name); }
      catch (error) { if (error.code !== 'ENOENT') throw filesystemError(error, 'read-failed'); }
    }
    let checkpoints;
    try { checkpoints = this.#directory.openDirectory(this.#rootFd, 'checkpoints'); }
    catch (error) {
      if (error.code === 'ENOENT') return result;
      throw filesystemError(error, 'unsafe-path');
    }
    try {
      return withFd(checkpoints, fd => {
        for (const name of this.#names(fd)) {
          if (name.startsWith('.tmp-')) continue;
          if (!CHECKPOINT.test(name) || name.endsWith('\n')) throw new BrokerError('unsafe-path');
          withFd(this.#directory.openDirectory(fd, name), checkpoint => {
            const files = this.#names(checkpoint);
            if (files.length !== CHECKPOINT_FILES.length || files.some((file, index) => file !== CHECKPOINT_FILES[index])) {
              throw new BrokerError('unsafe-path');
            }
            for (const file of files) result['checkpoints/' + name + '/' + file] = this.#hash(checkpoint, file);
          });
        }
        return result;
      });
    } catch (error) { throw filesystemError(error, 'read-failed'); }
  }

  list(path = '') {
    try { return this.#withDirectory(parts(path, true), fd => this.#names(fd)); }
    catch (error) { throw filesystemError(error, 'unsafe-path'); }
  }
}
