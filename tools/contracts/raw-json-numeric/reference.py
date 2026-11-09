"""Emit a fixed synthetic numeric oracle; never accept caller-selected inputs."""

import json
import math
import random
import struct
import sys
import unicodedata


SEED = 0x5A17C0DE
SAMPLES = 4096


def float_bits(value):
    return struct.pack(">d", value).hex()


def tokens():
    yield from [
        "0", "-0", "1", "-1", "1.0", "1e0", "1E+0", "-0.0", "-0e100",
        "9007199254740991", "9007199254740992", "9007199254740993",
        "-9007199254740993", "9007199254740993.0", "9007199254740995.0",
        "NaN", "Infinity", "-Infinity", "1e999999", "-1e999999",
        "1e-999999", "-1e-999999", "5e-324", "2e-324", "3e-324",
        "2.2250738585072014e-308", "2.2250738585072011e-308",
        "1.7976931348623157e308", "1.7976931348623159e308",
        "1.00000000000000011102230246251565404236316680908203125",
        "1.00000000000000011102230246251565404236316680908203126",
        "0.1000000000000000055511151231257827021181583404541015625",
        "1.2345678901234567", "1000000000000000100.0",
    ]
    for exponent in range(-324, 310):
        yield f"1e{exponent}"
    random_source = random.Random(SEED)
    for index in range(SAMPLES):
        bits = random_source.getrandbits(64)
        value = struct.unpack(">d", bits.to_bytes(8, "big"))[0]
        if not math.isfinite(value):
            # Explicit non-finite cases above cover JSON's accepted spellings.
            value = math.copysign(0.0, value)
        yield repr(value)
        if index < 512:
            for precision in (17, 18):
                decimal = format(value, f".{precision}g")
                if "." not in decimal and "e" not in decimal:
                    decimal += ".0"
                yield decimal


def main():
    if len(sys.argv) != 1 or sys.stdin.read(1):
        sys.stderr.write("reference_input_rejected\n")
        return 2
    cases = []
    for token in tokens():
        value = json.loads(token)
        kind = "int" if isinstance(value, int) else "float"
        cases.append({
            "token": token,
            "kind": kind,
            "scope": json.dumps(value),
            "bits": float_bits(value) if kind == "float" else None,
        })
    result = {
        "provenance": {
            "implementation": sys.implementation.name,
            "python": sys.version.split()[0],
            "unicode": unicodedata.unidata_version,
            "intMaxStrDigits": sys.get_int_max_str_digits(),
        },
        "seed": SEED,
        "binary64Samples": SAMPLES,
        "decimalVariants": 1024,
        "cases": cases,
    }
    sys.stdout.write(json.dumps(result, allow_nan=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
