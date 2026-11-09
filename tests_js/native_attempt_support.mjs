import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const repositoryRoot = new URL('../', import.meta.url);
export async function python(args, code) {
  try {
    const result = await promisify(execFile)('python3', code ? ['-c', code, ...args] : ['scripts/job-apply-attempt.py', ...args],
      {cwd: repositoryRoot, timeout:15000});
    return {...result, exitCode:0};
  } catch (error) { return {stdout:error.stdout, stderr:error.stderr, exitCode:error.code}; }
}
export const oracleImport = `import importlib.util,json,sys,os\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('attempt','scripts/job-apply-attempt.py')\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n`;

import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageNativeLock } from '../scripts/smoke/package_native_lock.mjs';
export async function installAttempt(fixture) {
  const root=join(await realpath(fixture.root),'installed');
  await mkdir(root);
  await cp(new URL('../runtime/',import.meta.url),join(root,'runtime'),{recursive:true});
  await mkdir(join(root,'native/posix'),{recursive:true});
  await cp(new URL('../native/posix/flock.c',import.meta.url),join(root,'native/posix/flock.c'));
  await mkdir(join(root,'qa/fixtures'),{recursive:true});
  await cp(new URL('../qa/fixtures/greenhouse-form-readiness-v1/',import.meta.url),join(root,'qa/fixtures/greenhouse-form-readiness-v1'),{recursive:true});
  await writeFile(join(root,'package.json'),'{"type":"module"}');
  await packageNativeLock(root);
  return join(root,'runtime/cli/native-attempt.js');
}
export async function nativeCli(executable,root,args,env={}) {
  try {
    const result=await promisify(execFile)(process.execPath,[executable,'--root',root,...args],{env:{...process.env,PATH:'',...env},timeout:15000});
    return {...result,exitCode:0,value:JSON.parse(result.stdout)};
  } catch(error) {return {stdout:error.stdout,stderr:error.stderr,exitCode:error.code,value:JSON.parse(error.stdout)};}
}
export async function killAttempt(root) {
  try {const pid=Number((await readFile(join(root,'.job-apply-attempt.pid'),'utf8')).trim());if(pid!==process.pid)process.kill(pid,'SIGKILL');} catch(error) {
    if(!['ENOENT','ESRCH'].includes(error.code)) throw error;
  }
}
export async function eventually(check) {
  for(let i=0;i<100;i++) {if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}
  throw Error('condition did not become true');
}

export async function rawAttempt(root,bytes) {
  const {createConnection}=await import('node:net');
  const {attemptSocketPath}=await import('../runtime/cli/attempt-protocol.js');
  return new Promise((resolve,reject)=>{
    const socket=createConnection(attemptSocketPath(root,process.getuid()));let output='';
    socket.on('connect',()=>socket.end(bytes));
    socket.on('data',bytes=>{output+=bytes;});
    socket.on('end',()=>{socket.destroy();try{resolve(JSON.parse(output));}catch(error){reject(error);}});
    socket.on('error',reject);socket.setTimeout(2000,()=>{socket.destroy();reject(Error('raw attempt timeout'));});
  });
}
