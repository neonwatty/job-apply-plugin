"""Synthetic bytes through real child stdin; no Store or caller-selected input."""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CHILD = r'''
import importlib.util
import json
import platform
import sys
import unicodedata
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root / 'scripts'))
if sys.argv[2] == 'store':
    spec = importlib.util.spec_from_file_location(
        'synthetic_stdin_store', root / 'scripts/job-apply-store.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
else:
    import job_apply_policy as module
try:
    value = module._read_input('-')
    outcome = {
        'ok': True,
        'serialized': json.dumps(value, ensure_ascii=True, separators=(',', ':')),
    }
except Exception as error:
    name = type(error).__name__
    if name not in {'StoreError','PolicyError','UnicodeDecodeError','RecursionError'}:
        raise
    outcome = {'ok': False, 'error': name}
    if name in {'StoreError','PolicyError'}:
        outcome['message'] = str(error)
receipt = {
    'provenance': {
        'implementation': platform.python_implementation(),
        'python': platform.python_version(),
        'unicode': unicodedata.unidata_version,
        'stdinEncoding': sys.stdin.encoding,
        'stdinErrors': sys.stdin.errors,
        'stdinIsatty': sys.stdin.isatty(),
        'utf8Mode': sys.flags.utf8_mode,
        'recursionLimit': sys.getrecursionlimit(),
    },
    'outcome': outcome,
}
print(json.dumps(receipt, ensure_ascii=True))
'''


def cases():
    return [
        ("object", b'{}'),
        ("bom", b'\xef\xbb\xbf{}'),
        ("non-ascii", '{"s":"é😀"}'.encode("utf-8")),
        ("invalid-byte-string", b'{"s":"\xff"}'),
        ("invalid-byte-outside", b'\xff{}'),
        ("surrogate-utf8", b'{"s":"\xed\xa0\x80"}'),
        ("escaped-surrogate", b'{"s":"\\ud800"}'),
        ("duplicate-key", b'{"a":1,"\\u0061":1.0}'),
        ("newlines", b'\r\n{\r\n"s":"a"}\r\n'),
        ("raw-string-crlf", b'{"s":"a\r\nb"}'),
        ("non-object", b'[]'),
        ("utf16-bom", b'\xff\xfe{\x00}\x00'),
        ("nested-64", b'{"a":' + b'[' * 64 + b'null' + b']' * 64 + b'}'),
        ("nested-2000", b'{"a":' + b'[' * 2000 + b'null' + b']' * 2000 + b'}'),
    ]


def capture():
    observations = []
    for family in ("store", "policy"):
        for identifier, payload in cases():
            result = subprocess.run(
                [sys.executable, "-I", "-c", CHILD, str(ROOT), family],
                input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=3, check=False,
            )
            if result.returncode or result.stderr or len(result.stdout) > 16384:
                raise RuntimeError("synthetic_stdin_child_failed")
            observation = json.loads(result.stdout)
            observations.append({"id": identifier, "family": family,
                                 "inputHex": payload.hex(), **observation})
    return {"schemaVersion": 1, "inputModel": "actual-pipe-stdin-isolated-python",
            "cases": observations}


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("reference_input_rejected\n")
        sys.exit(2)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
