import { PythonUnicodeDecodeError } from "./python-byte-errors.js";

export function decodePythonUtf16(bytes: Buffer, start: number, littleEndian: boolean): number[] {
  const points: number[] = [];
  const unit = (index: number) => littleEndian
    ? bytes[index]! + bytes[index + 1]! * 256 : bytes[index]! * 256 + bytes[index + 1]!;
  for (let index = start; index < bytes.length;) {
    if (index + 1 >= bytes.length) {
      throw new PythonUnicodeDecodeError(littleEndian ? "utf-16-le" : "utf-16-be",
        bytes, index, bytes.length, "truncated data");
    }
    const first = unit(index);
    index += 2;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < bytes.length) {
      const second = unit(index);
      if (second >= 0xdc00 && second <= 0xdfff) {
        points.push(0x10000 + (first - 0xd800) * 1024 + second - 0xdc00);
        index += 2;
        continue;
      }
    }
    points.push(first);
  }
  return points;
}
