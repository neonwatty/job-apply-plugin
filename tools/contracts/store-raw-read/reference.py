"""Fixed synthetic filesystem reference; never accepts a caller path or input."""

import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import sys
import tempfile
import unicodedata

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
from job_apply_store.io import read_json_object


CASES = [
    ("empty-object", b"{}", "file"),
    ("typed-values", b'{"a":1,"b":1.0,"c":9007199254740993,"d":NaN,"e":-0.0}', "file"),
    ("future-schema", b'{"schemaVersion":99}', "file"),
    ("duplicate-key", b'{"a":1,"a":2.0}', "file"),
    ("utf8", '{"text":"é😀"}'.encode("utf-8"), "file"),
    ("invalid-utf8", b'{"text":"\xff"}', "file"),
    ("truncated-utf8", b'{"text":"\xe2\x82', "file"),
    ("bom", b'\xef\xbb\xbf{}', "file"),
    ("crlf", b'{\r\n"a":1\r\n}', "file"),
    ("bare-cr", b'{\r"a":1\r}', "file"),
    ("empty-file", b"", "file"),
    ("invalid-json", b'{"a":}', "file"),
    ("array", b"[]", "file"),
    ("scalar", b"1", "file"),
    ("null", b"null", "file"),
    ("missing-file", None, "missing"),
    ("missing-parent", None, "missing-parent"),
    ("directory", None, "directory"),
    ("symlink", b'{"linked":true}', "symlink"),
    ("broken-symlink", None, "broken-symlink"),
    ("parent-symlink", b'{"parent":true}', "parent-symlink"),
    ("integer-digit-limit", b'{"a":' + b"9" * 4301 + b'}', "file"),
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def snapshot(root):
    """Record every entry without following links or observing access times."""
    entries = []

    def visit(path, relative):
        info = path.lstat()
        kind = ("symlink" if stat.S_ISLNK(info.st_mode) else
                "directory" if stat.S_ISDIR(info.st_mode) else "file")
        record = {
            "path": relative,
            "kind": kind,
            "mode": stat.S_IMODE(info.st_mode),
            "mtimeNs": str(info.st_mtime_ns),
            "sha256": digest(path.read_bytes()) if kind == "file" else None,
            "target": os.readlink(path) if kind == "symlink" else None,
        }
        entries.append(record)
        if kind == "directory":
            for child in sorted(path.iterdir(), key=lambda item: item.name):
                visit(child, child.name if relative == "." else relative + "/" + child.name)

    visit(root, ".")
    return entries


def prepare(root, data, kind):
    requested = root / "input.json"
    if kind == "file":
        requested.write_bytes(data)
    elif kind == "directory":
        requested.mkdir()
    elif kind == "missing-parent":
        requested = root / "absent" / "input.json"
    elif kind in ("symlink", "broken-symlink"):
        if kind == "symlink":
            (root / "target.json").write_bytes(data)
        requested.symlink_to("target.json")
    elif kind == "parent-symlink":
        (root / "target").mkdir()
        (root / "target" / "input.json").write_bytes(data)
        (root / "alias").symlink_to("target", target_is_directory=True)
        requested = root / "alias" / "input.json"
    return requested


def run_case(identifier, data, kind):
    with tempfile.TemporaryDirectory(prefix="raw-read-reference-") as directory:
        root = Path(directory)
        native = "symlink" in kind
        try:
            requested = prepare(root, data, kind)
        except (OSError, NotImplementedError) as error:
            if not native:
                raise
            return {
                "id": identifier, "inputHex": data.hex() if data is not None else None,
                "status": "unavailable", "native": True,
                "outcome": {"kind": "unavailable", "name": type(error).__name__},
                "before": [], "after": [], "unchanged": None,
            }
        before = snapshot(root)
        try:
            result = read_json_object(requested, "synthetic document")
            outcome = {"kind": "value", "json": json.dumps(
                result, ensure_ascii=True, sort_keys=True, separators=(",", ":")
            )}
        except Exception as error:
            # Preserve the legacy message except the synthetic ephemeral root.
            # This substitution is fixture-path binding, not error normalization.
            outcome = {"kind": "error", "name": type(error).__name__,
                       "message": str(error).replace(str(root), "<fixture>"),
                       "cause": type(error.__cause__).__name__ if error.__cause__ else None}
        after = snapshot(root)
        return {
            "id": identifier, "inputHex": data.hex() if data is not None else None,
            "status": "observed", "native": native, "outcome": outcome,
            "before": before, "after": after, "unchanged": before == after,
        }


def main():
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("raw_read_reference_input_rejected\n")
        return 2
    output = {
        "schemaVersion": 1,
        "provenance": {
            "implementation": platform.python_implementation(),
            "python": platform.python_version(),
            "unicode": unicodedata.unidata_version,
            "platform": sys.platform,
            "osName": os.name,
            "intMaxStrDigits": sys.get_int_max_str_digits(),
            "recursionLimit": sys.getrecursionlimit(),
            "sourceSha256": digest((ROOT / "scripts/job_apply_store/io.py").read_bytes()),
        },
        "cases": [run_case(*case) for case in CASES],
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=True, allow_nan=False) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("raw_read_reference_failed\n")
        raise SystemExit(2)
