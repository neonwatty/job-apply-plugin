"""Synthetic fixtures and value-preserving receipts; never initialize a Store."""
import hashlib
import json
import os
import stat
from pathlib import Path


def event(**changes):
    result = {"schemaVersion": 1, "eventId": "synthetic-id", "applicationId": "app-1",
              "event": "started", "answerKeys": [], "at": "synthetic-time"}
    result.update(changes)
    return result


def wire(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def line(value):
    return wire(value).encode("ascii") + b"\n"


def error_receipt(error, root):
    if error is None:
        return None
    context = error.__context__
    return {"name": type(error).__name__, "message": str(error).replace(str(root), "<ROOT>"),
            "errno": getattr(error, "errno", None),
            "context": error_receipt(context, root) if context is not None else None,
            "causeIsContext": error.__cause__ is context and context is not None,
            "details": {"line": error.lineno, "column": error.colno, "position": error.pos}
            if isinstance(error, json.JSONDecodeError) else
            {"encoding": error.encoding, "start": error.start, "end": error.end,
             "reason": error.reason, "inputHex": error.object.hex()}
            if isinstance(error, UnicodeDecodeError) else None}


def snapshot(root):
    rows = []
    for path in [root, *sorted(root.iterdir())]:
        info = path.lstat()
        kind = "link" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "file"
        data = path.read_bytes() if kind == "file" else None
        rows.append({"path": "." if path == root else path.name, "kind": kind,
                     "mode": stat.S_IMODE(info.st_mode), "size": info.st_size if kind == "file" else None,
                     "mtimeNs": str(info.st_mtime_ns), "ctimeNs": str(info.st_ctime_ns),
                     "hex": data.hex() if data is not None else None,
                     "sha256": hashlib.sha256(data).hexdigest() if data is not None else None,
                     "target": os.readlink(path) if kind == "link" else None})
    return rows


def reader_cases():
    valid = line(event())
    invalid = line(event(extra="unsupported"))
    return {
        "missing": None, "empty": b"", "valid": valid, "unterminated-valid": valid[:-1],
        "blank-lines": b"\n \t\r\n" + valid + b"\n", "unicode-blank": "\u0085\u2003\n".encode() + valid,
        "cr-crlf": valid.replace(b"\n", b"\r") + valid.replace(b"\n", b"\r\n"),
        "unknown-event": line(event(event="future-event")),
        "missing-schema": line({key: value for key, value in event().items() if key != "schemaVersion"}),
        "float-schema": line(event(schemaVersion=1.0)), "bool-schema": line(event(schemaVersion=True)),
        "future-schema": line(event(schemaVersion=2)), "old-schema": line(event(schemaVersion=0)),
        "null-object": b"null\n", "array-object": b"[]\n", "physical-line-label": b"\n \t\n[]\n",
        "malformed-json": b"{\n", "bom": b"\xef\xbb\xbf" + valid,
        "invalid-utf8": b"\xff\n", "schema-before-json": b"{}\n{\n",
        "json-before-schema": b"{\n{}\n", "record-before-json": invalid + b"{\n",
        "read-ahead-utf8-before-record": invalid + b"\xff\n",
        "record-before-distant-utf8": invalid + b" " * 16384 + b"\xff\n",
        "json-before-distant-utf8": b"{\n" + b" " * 16384 + b"\xff\n",
        "utf8-at-8191": b" " * 8191 + b"\xff\n", "utf8-at-8192": b" " * 8192 + b"\xff\n",
        "split-multibyte": b" " * 8191 + "\u2003\n".encode() + valid,
        "surrogate-text": line(event(role="\ud800")), "duplicate-keys": valid.replace(b'"event":"started"', b'"event":"bad","event":"started"'),
        "integer-limit": b'{"schemaVersion":1' + b"0" * 4300 + b'}\n',
        "directory": "directory", "symlink": "symlink", "broken-symlink": "broken-symlink",
    }


def validation_cases():
    result = {"valid": event(), "unknown-event": event(event="future-event"),
              "bad-event": event(event="Started"), "empty-event": event(event=""),
              "long-event": event(event="a" * 65), "event-newline": event(event="started\n"),
              "unsupported-field": event(extra=1), "bad-id": event(applicationId="a..b"),
              "id-nonascii": event(applicationId="\u03bb"), "id-long": event(applicationId="a" * 129),
              "id-boundary": event(applicationId="a" * 128), "empty-event-id": event(eventId=""),
              "null-event-id": event(eventId=None), "empty-time": event(at=""),
              "keys-not-list": event(answerKeys="a"), "keys-mixed": event(answerKeys=["a", 1]),
              "optional-null": event(company=None, role=None, ats=None, status=None),
              "optional-multiple": event(company=1, role=2, ats=3, status=4),
              "missing-schema": {key: value for key, value in event().items() if key != "schemaVersion"},
              "float-schema": event(schemaVersion=1.0), "arbitrary-schema": event(schemaVersion=[False]),
              "surrogate-text": event(role="\ud800"), "future-event-boundary": event(event="a" * 64)}
    for key in ["applicationId", "event", "eventId", "at", "answerKeys"]:
        result["missing-" + key] = {name: value for name, value in event().items() if name != key}
    for key in ["company", "role", "ats", "status"]:
        result["optional-" + key] = event(**{key: 1})
    return result


def identity_cases():
    same = event()
    reordered = dict(reversed(list(same.items())))
    other = event(eventId="unrelated")
    return {
        "missing": (same, None), "empty": (same, b""), "unrelated": (same, line(other)),
        "same": (same, line(same)),
        "reordered": (same, (json.dumps(reordered, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")),
        "duplicates-equal": (same, line(same) * 2),
        "collision": (same, line(event(role="different"))),
        "mixed-collision": (same, line(same) + line(event(role="different"))),
        "first-collision": (same, line(event(role="different")) + line(same)),
        "float-int-identity": (event(schemaVersion=1.0), line(same)),
        "missing-schema-identity": ({key: value for key, value in same.items() if key != "schemaVersion"}, line(same)),
        "surrogate-equal": (event(role="\ud800"), line(event(role="\ud800"))),
        "surrogate-pair-collision": (event(role="\ud83d\ude00"), line(event(role="\U0001f600"))),
        "bool-int-identity": (event(schemaVersion=True), line(same)),
        "arbitrary-schema-unmatched": (event(schemaVersion=[False]), line(other)),
        "nonascii-equal": (event(role="\u03bb\U0001f600"), line(event(role="\u03bb\U0001f600"))),
        "invalid-incoming-before-file": (event(event="future-event"), b"\xff"),
        "later-malformed-before-comparison": (same, line(same) + b"{\n"),
        "unknown-unrelated-record": (same, line(event(eventId="unrelated", event="future-event"))),
    }
