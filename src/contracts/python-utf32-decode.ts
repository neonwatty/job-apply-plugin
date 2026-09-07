import { PythonUnicodeDecodeError } from "./python-byte-errors.js";

export function decodePythonUtf32(bytes: Buffer, start: number, littleEndian: boolean): number[] {
  const points: number[] = [];
  const encoding = littleEndian ? "utf-32-le" : "utf-32-be";
  for (let index = start; index < bytes.length; index += 4) {
    if (index + 3 >= bytes.length) {
      throw new PythonUnicodeDecodeError(encoding, bytes, index, bytes.length, "truncated data");
    }
    const point = littleEndian
      ? bytes[index]! + bytes[index + 1]! * 256 + bytes[index + 2]! * 65536 + bytes[index + 3]! * 16777216
      : bytes[index]! * 16777216 + bytes[index + 1]! * 65536 + bytes[index + 2]! * 256 + bytes[index + 3]!;
    if (point > 0x10ffff) {
      throw new PythonUnicodeDecodeError(encoding, bytes, index, index + 4, "code point not in range(0x110000)");
    }
    points.push(point);
  }
  return points;
}
