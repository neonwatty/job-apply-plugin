import { createHash } from 'node:crypto';

export const sourceData = Buffer.from('synthetic-source\0\xff\n', 'latin1');
const oldData = Buffer.from('old-target\0\xfe', 'latin1');
export const digest = bytes => ({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  hex: bytes.length <= 64 ? bytes.toString('hex') : null });
export const failure = (name, message, errno, stage) => Object.assign(new Error(message), {
  name, ...(errno === undefined ? {} : { errno }), ...(stage === undefined ? {} : { stage }),
});
export const injected = stage => failure('InjectedFailure', '[Errno 5] synthetic ' + stage, 5, stage);
export function errorReceipt(error) {
  if (!error) return null;
  return { name: error.name, message: error.message, errno: error.errno ?? null, stage: error.stage ?? null,
    context: error.pythonContext ? errorReceipt(error.pythonContext) : null };
}

/** Deterministic stream-level test model, deliberately not a native adapter. */
export function model(lane, id, profile, sourceOverride) {
  const bufferSize = profile === '3.14' ? 262144 : 65536;
  const bytes = id === 'empty' ? Buffer.alloc(0) : ['multichunk', 'partial-read-error', 'partial-write-error'].includes(id)
    ? Buffer.from(Array.from({ length: bufferSize * 2 + 17 }, (_, i) => i % 251)) : sourceOverride ?? sourceData;
  const entries = new Map([['.', { kind: 'directory', mode: 0o700 }],
    ['source', { kind: 'file', mode: 0o640, bytes }], ['target', { kind: 'file', mode: 0o600, bytes: oldData }]]);
  const file = name => {
    const item = entries.get(name);
    return item?.kind === 'link' ? entries.get(item.target) : item;
  };
  if (id.startsWith('new-') || id === 'source-link') entries.delete('target');
  if (id === 'source-missing') entries.delete('source');
  if (id === 'hardlink') entries.set('target', entries.get('source'));
  for (const owner of ['source', 'target']) {
    if (id === `${owner}-fifo`) entries.set(owner, { kind: 'fifo', mode: owner === 'source' ? 0o640 : 0o600 });
    if (id === `${owner}-link`) {
      entries.set('referent', { kind: 'file', bytes: owner === 'source' ? bytes : oldData, mode: owner === 'source' ? 0o666 & ~process.umask() : 0o600 });
      entries.set(owner, { kind: 'link', mode: 0o777 & ~process.umask(), target: 'referent' });
    }
  }
  if (id === 'target-directory') entries.set('target', { kind: 'directory', mode: 0o777 & ~process.umask() });
  const source = '<ROOT>/source';
  const target = id === 'same-path' ? source : '<ROOT>/target';
  const short = path => path.replace('<ROOT>/', '');
  const calls = [], protocol = [], handles = [];
  let reads = 0, writes = 0;
  const mark = (stage, args = {}) => calls.push({ stage, ...args });
  function open(owner, path) {
    mark(owner + '-open', { path: owner, mode: owner === 'source' ? 'rb' : 'wb' });
    if (id === `${owner}-open-error`) throw injected(owner + '-open');
    const name = short(path);
    let item = file(name);
    if (!item && owner === 'source') throw failure('FileNotFoundError', `[Errno 2] No such file or directory: '${path}'`, 2);
    if (item?.kind === 'directory') throw failure('IsADirectoryError', `[Errno 21] Is a directory: '${path}'`, 21);
    if (!item) { item = { kind: 'file', mode: id === 'new-077' ? 0o600 : 0o644, bytes: Buffer.alloc(0) }; entries.set(name, item); }
    if (owner === 'target') item.bytes = Buffer.alloc(0);
    let position = 0;
    let pending = Buffer.alloc(0);
    const handle = {
      owner, open: true, item,
      async read(length) {
        reads += 1; mark('read', { length });
        if (['read-error', 'read-both-close-error'].includes(id) || id === 'partial-read-error' && reads === 2) throw injected('read');
        const part = item.bytes.subarray(position, position + length); position += part.length;
        mark('read-result', digest(part)); return part;
      },
      async write(value) {
        writes += 1; mark('write', digest(value));
        if (['write-error', 'write-target-close-error'].includes(id) || id === 'partial-write-error' && writes === 2) throw injected('write');
        const part = id === 'short-write' ? value.subarray(0, 3) : value;
        // The frozen cases distinguish small pending writes from full copy chunks.
        // This intentionally models only those boundaries, not Python raw buffering.
        if (part.length >= bufferSize) { item.bytes = Buffer.concat([item.bytes, pending, part]); pending = Buffer.alloc(0); }
        else pending = Buffer.concat([pending, part]);
        return part.length;
      },
      flush() { item.bytes = Buffer.concat([item.bytes, pending]); pending = Buffer.alloc(0); },
      async close() {
        mark(owner + '-close');
        if (id === `${owner}-close-error` || id === 'read-both-close-error'
          || id === 'write-target-close-error' && owner === 'target') throw injected(owner + '-close');
        if (owner === 'target') handle.flush();
        handle.open = false;
        if (id === `${owner}-close-after-error`) throw injected(owner + '-close-after');
      },
    };
    handles.push(handle); return handle;
  }
  const io = {
    pathRepr: path => `PosixPath('${path}')`,
    isOSError: error => error instanceof Error && (typeof error.errno === 'number' || error.name === 'OSError'),
    isDirectoryError: error => error instanceof Error && error.name === 'IsADirectoryError',
    async sameFile(left, right) { protocol.push('same-file'); return left === right || id === 'hardlink'; },
    async stat(path) {
      protocol.push('stat:' + short(path)); const item = file(short(path));
      if (!item) throw failure('FileNotFoundError', 'missing stat', 2);
      return { isFIFO: () => item.kind === 'fifo' };
    },
    async isLink(path) { protocol.push('is-link:' + short(path)); return entries.get(short(path))?.kind === 'link'; },
    async readLink(path) { protocol.push('read-link:' + short(path)); return entries.get(short(path)).target; },
    async symlink(link, path) { protocol.push('symlink:' + short(path)); entries.set(short(path), { kind: 'link', mode: 0o755, target: link }); },
    async exists(path) { protocol.push('exists:' + short(path)); return file(short(path)) !== undefined; },
    async openSource(path) { return open('source', path); },
    async openTarget(path) { return open('target', path); },
  };
  if (lane === 'native') io.accelerate = async (reader, writer) => {
    // Model the frozen successful accelerator result; never run a native syscall.
    writer.item.bytes = Buffer.from(reader.item.bytes); return 'copied';
  };
  if (lane === 'accelerator') io.accelerate = async (reader, writer) => {
    mark('accelerator', { helper: '_fastcopy_fcopyfile' });
    if (id === 'fallback') return 'give-up';
    const part = await reader.read(7); await writer.write(part); writer.flush();
    mark('accelerator-mutation', { target: digest(writer.item.bytes) }); throw injected('accelerator-after-write');
  };
  return { io, calls, protocol, source, target, removeTarget: () => entries.delete('target'),
    snapshot: () => [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([path, item]) => ({ path,
      kind: item.kind, mode: item.mode, content: item.kind === 'file' ? digest(item.bytes) : null, target: item.target ?? null })),
    descriptors: () => handles.map(handle => ({ owner: handle.owner, open: handle.open, size: handle.open ? handle.item.bytes.length : null })),
  };
}

export const branchProbe = String.raw`
import builtins, hashlib, json, os, platform, shutil, sys, tempfile
from pathlib import Path
from unittest.mock import patch
class DirectoryChild(IsADirectoryError): pass
class OtherOSError(OSError): pass
original_exists = os.path.exists
cases = ['source-open', 'target-open', 'read', 'target-close-missing', 'target-close-existing', 'source-close', 'target-open-source-close', 'exists-error', 'reused-error-context', 'target-open-child', 'target-open-other21']
rows = []
for case in cases:
 with tempfile.TemporaryDirectory(prefix='data-copy-branch-') as temporary:
  root=Path(temporary); src=root/'source'; dst=root/'target'
  src.write_bytes(b'synthetic-source\x00\xff\n')
  calls=[]; handles=[]; error=None
  reused_a=RuntimeError('synthetic reused A'); reused_b=RuntimeError('synthetic reused B')
  def raised(stage):
   kind=DirectoryChild if case=='target-open-child' else OtherOSError if case=='target-open-other21' else IsADirectoryError
   value=kind(21, 'synthetic '+stage)
   return value
  def opened(path, mode):
   owner='source' if mode=='rb' else 'target'
   calls.append(owner+'-open')
   if owner=='source' and case=='source-open': raise raised('source-open')
   if owner=='target' and case in ['target-open','target-open-source-close','exists-error','target-open-child','target-open-other21']: raise raised('target-open')
   stream=builtins.open(path,mode); handles.append(stream)
   class Wrapped:
    def __enter__(self): return self
    def __exit__(self,kind,value,tb):
     calls.append(owner+'-close'); stream.close()
     if case=='reused-error-context': raise reused_b if owner=='target' else reused_a
     if owner=='target' and case.startswith('target-close'):
      if case=='target-close-missing': dst.unlink(); calls.append('remove-target')
      raise raised('target-close')
     if owner=='source' and case=='source-close': raise raised('source-close')
     if owner=='source' and case=='target-open-source-close': raise OSError(5,'synthetic source-close')
    def read(self,length):
     calls.append('read')
     if case=='reused-error-context': raise reused_a
     if case=='read': dst.unlink(); calls.append('remove-target'); raise raised('read')
     return stream.read(length)
    def write(self,data): calls.append('write'); return stream.write(data)
   return Wrapped()
  def exists(path):
   assert path==dst; calls.append('exists-target')
   if case=='exists-error': raise RuntimeError('synthetic exists')
   return original_exists(path)
  def record(value):
   if value is None: return None
   return {'name':type(value).__name__,'message':str(value).replace(str(root),'<ROOT>'),'errno':getattr(value,'errno',None),
    'context':record(value.__context__),'cause':record(value.__cause__),'suppressContext':value.__suppress_context__}
  with patch.object(shutil,'open',opened,create=True), patch.object(os.path,'exists',exists):
   flags=[patch.object(shutil,name,False) for name in ['_HAS_FCOPYFILE','_USE_CP_SENDFILE','_USE_CP_COPY_FILE_RANGE'] if hasattr(shutil,name)]
   for flag in flags: flag.start()
   try:
    try: shutil.copyfile(src,dst,follow_symlinks=False)
    except BaseException as caught: error=caught
   finally:
    for flag in reversed(flags): flag.stop()
  rows.append({'id':case,'calls':calls,'error':record(error),'closed':[h.closed for h in handles],
   'target':dst.read_bytes().hex() if dst.exists() else None,'source':src.read_bytes().hex()})
classification=[]
for stage in ['samefile','stat']:
 for name in ['OSError','ValueError']:
  with tempfile.TemporaryDirectory(prefix='data-copy-class-') as temporary:
   src=Path(temporary)/'source';dst=Path(temporary)/'target';src.write_bytes(b'x')
   error=OSError('no errno') if name=='OSError' else ValueError('non OS')
   def failed(*args,**kwargs): raise error
   owner,attribute=(os.path,'samefile') if stage=='samefile' else (shutil,'_stat')
   outcome=None
   with patch.object(owner,attribute,failed):
    try: shutil.copyfile(src,dst)
    except BaseException as caught: outcome=type(caught).__name__
   classification.append({'stage':stage,'error':name,'outcome':outcome,'target':dst.read_bytes().hex() if dst.exists() else None})
print(json.dumps({'rows':rows,'classification':classification,'profile':{'python':platform.python_version(),'platform':sys.platform,'implementation':platform.python_implementation(),'executable':str(Path(sys.executable).resolve()),'executableSha256':hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()},'stdlib':{'path':shutil.__file__,'sha256':hashlib.sha256(Path(shutil.__file__).read_bytes()).hexdigest()}}))
`;
