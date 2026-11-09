"""Fixed in-memory ingress evidence. Never opens a Store or caller-selected file."""

import importlib.util
import io
import json
import platform
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
from job_apply_store.io import read_json_object
from job_apply_workspace.http import HttpMixin


def load_cli():
    spec = importlib.util.spec_from_file_location("synthetic_ingress_cli", ROOT / "scripts/job-apply-store.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MemoryPath:
    def __init__(self, data):
        self.data = data

    def open(self, *, encoding):
        return io.TextIOWrapper(io.BytesIO(self.data), encoding=encoding)

    def __str__(self):
        return "synthetic-document"


class MemoryHttp:
    def __init__(self, data):
        self.headers = {"Content-Type": "application/json", "Content-Length": str(len(data))}
        self.rfile = io.BytesIO(data)
        self.error = None

    def _error(self, status, message):
        self.error = {"ok": False, "error": "HTTP", "status": int(status), "message": message}


def outcome(function):
    try:
        value = function()
        return {"ok": True, "serialized": json.dumps(value, ensure_ascii=True, separators=(",", ":"))}
    except Exception as error:
        name = type(error).__name__
        if name not in {"StoreError", "UnicodeDecodeError", "JSONDecodeError"}:
            raise
        result = {"ok": False, "error": name}
        # Interpreter exception strings may contain input or paths. Keep only
        # reviewed application messages; these inputs and path labels are fixed.
        if name == "StoreError":
            result["message"] = str(error)
        return result


def stdin_input(cli, data):
    original = sys.stdin
    try:
        with io.TextIOWrapper(io.BytesIO(data), encoding="utf-8", errors="strict") as stream:
            sys.stdin = stream
            return cli._read_input("-")
    finally:
        sys.stdin = original


def capture():
    cli = load_cli()
    byte_cases = [
        ("utf8", b'{}'),
        ("utf8-bom", b'\xef\xbb\xbf{}'),
        ("utf16le", '{}'.encode('utf-16-le')),
        ("utf16be", '{}'.encode('utf-16-be')),
        ("utf32le", '{}'.encode('utf-32-le')),
        ("utf32be", '{}'.encode('utf-32-be')),
        ("utf16-bom", b'\xff\xfe' + '{}'.encode('utf-16-le')),
        ("utf32-bom", b'\x00\x00\xfe\xff' + '{}'.encode('utf-32-be')),
        ("surrogatepass", b'{"s":"\xed\xa0\x80"}'),
        ("invalid-utf8", b'{"s":"\xff"}'),
        ("newlines", b'\r\n{\r\n"s":"a"}\r\n'),
        ("raw-string-crlf", b'{"s":"a\r\nb"}'),
        ("non-object", b'[]'),
    ]
    cases = []
    for name, data in byte_cases:
        for ingress, function in [
            ("bytes-decoder", lambda: json.loads(data)),
            ("utf8-text-decoder", lambda: json.loads(data.decode("utf-8"))),
            ("document-wrapper", lambda: read_json_object(MemoryPath(data), "fixture")),
            ("stdin-wrapper", lambda: stdin_input(cli, data)),
        ]:
            cases.append({"id": name, "ingress": ingress, "outcome": outcome(function)})
        http = MemoryHttp(data)
        result = outcome(lambda: HttpMixin._read_json(http))
        cases.append({"id": name, "ingress": "http-wrapper", "outcome": http.error or result})
    for name, text in [
        ("object", "{}"), ("text-bom", "\ufeff{}"),
        ("whitespace", " \t\r\n{}"), ("nbsp-prefix", "\u00a0{}"),
        ("non-object", "[]"), ("escaped-surrogate", '{"s":"\\ud800"}'),
    ]:
        cases.append({"id": name, "ingress": "scope-wrapper", "outcome": outcome(lambda: cli._scope(text))})
    # The actual history wrapper validates event schemas too. This deliberately
    # captures only its line.strip()/loads branch, not filesystem/event behavior.
    for name, line in [("empty", ""), ("ascii", " \t\r\n"), ("nbsp", "\u00a0\n"),
                       ("em-space", "\u2003\n"), ("bom", "\ufeff\n"), ("object", "{}\n")]:
        result = {"ok": True, "skipped": True} if not line.strip() else outcome(lambda: json.loads(line))
        cases.append({"id": name, "ingress": "jsonl-branch", "outcome": result})
    return {
        "schemaVersion": 1,
        "provenance": {"implementation": platform.python_implementation(),
                       "python": platform.python_version(), "unicode": unicodedata.unidata_version,
                       "stdinEncoding": "utf-8", "stdinErrors": "strict",
                       "recursionLimit": sys.getrecursionlimit()},
        "coverage": {"byteInputs": 13, "scopeInputs": 6, "jsonlInputs": 6,
                     "wrapperCases": 45, "decoderCases": 26, "branchCases": 6},
        "cases": cases,
    }


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("reference_input_rejected\n")
        sys.exit(2)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
