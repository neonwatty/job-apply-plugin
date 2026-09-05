import { RecorderError } from "./errors.mjs";
import { CAPTURE_LIMITS } from "./resources.mjs";

function pngCrc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function base64Value(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function isCanonicalBase64(data) {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  let padding = 0;
  if (data.charCodeAt(data.length - 1) === 61) padding += 1;
  if (data.charCodeAt(data.length - 2) === 61) padding += 1;
  const contentLength = data.length - padding;
  if (contentLength === 0 || contentLength % 4 !== (4 - padding) % 4) return false;
  for (let index = 0; index < contentLength; index += 1) {
    if (base64Value(data.charCodeAt(index)) < 0) return false;
  }
  for (let index = contentLength; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 61) return false;
  }
  const finalValue = base64Value(data.charCodeAt(contentLength - 1));
  if ((padding === 1 && (finalValue & 0x03) !== 0) ||
      (padding === 2 && (finalValue & 0x0f) !== 0)) return false;
  return true;
}

export function decodeCapturedPng(data, expectedWidth, expectedHeight, maxBytes) {
  const byteLimit = maxBytes ?? CAPTURE_LIMITS.maxScreenshotBytes;
  const fail = () => { throw new RecorderError("invalid screenshot capture"); };
  if (typeof data !== "string" || data.length === 0 ||
      !Number.isSafeInteger(expectedWidth) || expectedWidth <= 0 ||
      !Number.isSafeInteger(expectedHeight) || expectedHeight <= 0 ||
      !Number.isSafeInteger(byteLimit) || byteLimit <= 0 ||
      data.length > Math.ceil(byteLimit / 3) * 4 ||
      !isCanonicalBase64(data)) {
    fail();
  }
  const png = Buffer.from(data, "base64");
  if (png.length > byteLimit || png.toString("base64") !== data || png.length < 45 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail();
  }
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  while (offset < png.length) {
    if (png.length - offset < 12) fail();
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (length > byteLimit || dataEnd < dataStart || chunkEnd > png.length) fail();
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) ||
        pngCrc32(png, offset + 4, dataEnd) !== png.readUInt32BE(dataEnd)) {
      fail();
    }
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13 ||
          png.readUInt32BE(dataStart) !== expectedWidth ||
          png.readUInt32BE(dataStart + 4) !== expectedHeight) fail();
      sawHeader = true;
    } else if (type === "IHDR") {
      fail();
    }
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== png.length) fail();
      sawEnd = true;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawEnd || offset !== png.length) fail();
  return png;
}
