import { posix } from 'node:path';
import { JobsError } from './values.js';
export const resumeLimit = 10 * 1024 * 1024;
export const resumeMedia: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8',
};
export function resumeExtension(filename: string): string {
  if (!filename || posix.basename(filename) !== filename || filename.includes('\0') || ['.', '..'].includes(filename)) throw new JobsError('resume filename is invalid');
  const extension = posix.extname(filename).toLowerCase();
  if (!Object.hasOwn(resumeMedia, extension)) throw new JobsError('resume format must be PDF, DOCX, or UTF-8 TXT');
  return extension;
}
/** Validate the ZIP directory without extracting or inflating untrusted content. */
function docxNames(bytes: Buffer): string[] {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw Error('zip');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
  if (count === 65535 || bytes.readUInt16LE(end + 8) !== count || size > end) throw Error('zip');
  let offset = end - size;
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw Error('zip');
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    if (offset + 46 + length + extra + comment > end) throw Error('zip');
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8').split('\0')[0]!;
    names.push(name);
    offset += 46 + length + extra + comment;
  }
  if (offset !== end) throw Error('zip');
  return names;
}
export function validateResumeContent(filename: string, content: Buffer): { extension: string; mediaType: string } {
  const extension = resumeExtension(filename);
  if (content.length > resumeLimit) throw new JobsError('resume file exceeds the 10 MiB limit');
  if (!content.length) throw new JobsError('resume file is empty');
  try {
    if (extension === '.pdf' && content.subarray(0, 5).toString('ascii') !== '%PDF-') throw Error('pdf');
    if (extension === '.txt') {
      if (content.includes(0)) throw Error('nul');
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    }
    if (extension === '.docx') {
      const names = docxNames(content);
      if (!names.includes('[Content_Types].xml') || !names.includes('word/document.xml')
        || names.some(name => name.startsWith('/') || name.replaceAll('\\', '/').split('/').includes('..'))) throw Error('docx');
    }
  } catch { throw new JobsError('resume content does not match its extension'); }
  return { extension, mediaType: resumeMedia[extension]! };
}
