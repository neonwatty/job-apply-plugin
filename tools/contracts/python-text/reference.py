"""Fixed builtin Python string behavior for the codepoint-text foundation."""
import hashlib
import json
import platform
import sys
from pathlib import Path

CASES = {
    "empty": [], "ascii": [65, 0, 127], "scalar": [0x10000],
    "literal-pair": [0xD800, 0xDC00], "high": [0xD800], "low": [0xDC00],
    "scalar-before-error": [0x1F600, 0xD800, 65],
    "surrogate-run": [65, 0xD800, 0xDC00, 0xDFFF, 66],
    "separate-errors": [0xD800, 65, 0xDC00],
    "unicode": [0x3BB, 0xE000, 0x10FFFF],
    "below-surrogate": [0xD7FF], "above-surrogate": [0xE000],
}


def encoded(value):
    try:
        return {"hex": value.encode("utf-8").hex()}
    except UnicodeEncodeError as error:
        return {"error": {"name": type(error).__name__, "encoding": error.encoding,
                          "start": error.start, "end": error.end,
                          "reason": error.reason, "message": str(error)}}


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("python_text_reference_input_rejected\n")
        sys.exit(2)
    values = {name: "".join(map(chr, points)) for name, points in CASES.items()}
    rows = [{"id": name, "points": list(map(ord, value)), "length": len(value),
             "utf8": encoded(value)} for name, value in values.items()]
    comparisons = [[(a > b) - (a < b) for b in values.values()] for a in values.values()]
    joins = [{"left": left, "right": right, "points": list(map(ord, values[left] + values[right])),
              "utf8": encoded(values[left] + values[right])}
             for left, right in [("high", "low"), ("scalar", "low"), ("empty", "literal-pair")]]
    print(json.dumps({"schemaVersion": 1, "profile": {"python": platform.python_version(),
        "implementation": platform.python_implementation(), "platform": sys.platform,
        "executablePath": str(Path(sys.executable).resolve()),
        "executableSha256": hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()},
        "cases": rows, "comparisons": comparisons, "joins": joins}, ensure_ascii=True))
