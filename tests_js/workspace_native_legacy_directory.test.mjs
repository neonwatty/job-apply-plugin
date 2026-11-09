import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { constants, closeSync, fstatSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';

// Exercise the exact addon directly, including argument safety beneath TS callers.
test('directory-relative discovery stays pinned through root replacement and rejects entry symlinks',async()=>{
  const fixture=await nativeFixture();
  const native=createRequire(import.meta.url)(fixture.receipt.artifact);
  let root;
  try {
    const source=join(fixture.root,'reports'), moved=join(fixture.root,'moved'), other=join(fixture.root,'other');
    await mkdir(source);await mkdir(other);
    await writeFile(join(source,'report.md'),'original');await writeFile(join(other,'report.md'),'substituted');
    root=await open(source,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    const metadata=native.inspect(root.fd,'report.md');
    assert.equal(typeof metadata.dev,'bigint');assert.equal(metadata.size,8n);
    assert.deepEqual(native.listNames(root.fd),[Buffer.from('report.md')]);
    assert.deepEqual(native.listNames(root.fd),[Buffer.from('report.md')],'repeated listing must rewind independently');
    await rename(source,moved);await symlink(other,source);
    assert.deepEqual(native.listNames(root.fd),[Buffer.from('report.md')]);
    const fd=native.openFile(root.fd,'report.md');
    try {
      const stat=fstatSync(fd,{bigint:true});
      assert.equal(stat.dev,metadata.dev);assert.equal(stat.ino,metadata.ino);
      assert.equal(readFileSync(fd,'utf8'),'original');
    } finally { closeSync(fd); }
    await symlink(join(other,'report.md'),join(moved,'link.md'));
    assert.equal(native.inspect(root.fd,'link.md').mode & constants.S_IFMT,constants.S_IFLNK);
    assert.throws(()=>native.openFile(root.fd,'link.md'),{code:'ELOOP'});
    await rename(join(moved,'report.md'),join(moved,'old.md'));
    await writeFile(join(moved,'report.md'),'new file');
    assert.notEqual(native.inspect(root.fd,'report.md').ino,metadata.ino,'entry replacement is observable to caller');
    for(const name of ['','.', '..','../report.md','a/b','report.md\0suffix','\ud800']) {
      assert.throws(()=>native.inspect(root.fd,name));assert.throws(()=>native.openFile(root.fd,name));
    }
    for(const descriptor of [-1,1.5,NaN,Infinity,'0']) assert.throws(()=>native.listNames(descriptor));
    assert.throws(()=>native.inspect(root.fd,'missing'),{code:'ENOENT'});
    const closed=root.fd;await root.close();root=null;
    assert.throws(()=>native.listNames(closed),{code:'EBADF'});
  } finally { await root?.close();await fixture.cleanup(); }
});

test('Linux directory listing preserves arbitrary filename bytes',{skip:process.platform!=='linux'},async()=>{
  const fixture=await nativeFixture();
  const native=createRequire(import.meta.url)(fixture.receipt.artifact);
  let root;
  try {
    const source=join(fixture.root,'reports');
    await mkdir(source);
    const name=Buffer.from([0x75,0x6e,0x72,0x65,0x6c,0x61,0x74,0x65,0x64,0xff]);
    await writeFile(Buffer.concat([Buffer.from(`${source}/`),name]),'unrelated');
    root=await open(source,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    assert.deepEqual(native.listNames(root.fd),[name]);
  } finally { await root?.close();await fixture.cleanup(); }
});
