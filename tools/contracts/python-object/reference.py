"""Closed synthetic dictionary fixtures; no Store, paths, or caller data."""
import hashlib
import _json
import json
import platform
import sys
from pathlib import Path


def text(points):
    return "".join(chr(point) for point in points)


def wire(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "bool", "value": value}
    if isinstance(value, int):
        return {"type": "int", "decimal": str(value)}
    if isinstance(value, float):
        return {"type": "float", "repr": repr(value)}
    if isinstance(value, str):
        return {"type": "text", "points": list(map(ord, value))}
    if isinstance(value, list):
        return {"type": "list", "items": [wire(item) for item in value]}
    if isinstance(value, dict):
        return {"type": "dict", "entries": [[wire(key), wire(item)] for key, item in value.items()]}
    raise TypeError("unsupported fixed fixture")


def fixtures():
    rows = []
    first = text([97, 108, 112, 104, 97])
    equal = text([97, 108, 112, 104, 97])
    value = {first: 1, "middle": 2}
    value[equal] = 3
    rows.append({"id": "equal-overwrite", "value": wire(value),
                 "distinctInputs": first is not equal, "retainsFirstKey": next(iter(value)) is first,
                 "lookup": wire(value[equal])})

    pair, scalar = text([0xD800, 0xDC00]), text([0x10000])
    value = {pair: "pair", scalar: "scalar", text([0xD800]): "high"}
    rows.append({"id": "pair-scalar-coexist", "value": wire(value),
                 "lookups": [wire(value[text(points)]) for points in
                             [[0xD800, 0xDC00], [0x10000], [0xD800]]],
                 "size": len(value)})

    value = {"a": 1, "b": 2, "c": 3}
    del value["b"]
    value["b"] = 4
    value["a"] = 5
    rows.append({"id": "delete-reinsert", "value": wire(value)})

    value = {"a": 1}
    before = wire(value)
    try:
        del value["missing"]
    except KeyError as error:
        rows.append({"id": "missing-delete", "before": before, "after": wire(value),
                     "error": {"name": type(error).__name__, "args": wire(list(error.args)),
                               "message": str(error)}})

    points = [[0x10000], [0xD800, 0xDC00], [], [0xE000], [0xD800], [0xDC00], [0], [97]]
    value = {text(key): index for index, key in enumerate(points)}
    rows.append({"id": "insertion-and-sort", "value": wire(value),
                 "sortedKeys": [list(map(ord, key)) for key in sorted(value)]})

    value = {"": None, "false": False, "true": True, "integer": 1,
             "float": 1.0, "negative-zero": -0.0, "large": 9007199254740993,
             "empty-text": "", "empty-list": [], "empty-object": {}}
    rows.append({"id": "typed-values", "value": wire(value)})

    shared = []
    value = {"first": shared, "second": shared}
    value["first"].append(7)
    rows.append({"id": "shared-values", "value": wire(value),
                 "sameValue": value["first"] is value["second"]})

    value = {}
    value["self"] = value
    value["alias"] = value
    # Observe graph identity before JSON: never normalize cycles through JSON.
    cycle = {"id": "self-cycle", "keys": list(value), "size": len(value),
             "selfIdentity": value["self"] is value,
             "aliasIdentity": value["alias"] is value["self"]}
    try:
        json.dumps(value)
    except ValueError as error:
        cycle["jsonError"] = {"name": type(error).__name__, "message": str(error)}
    rows.append(cycle)

    for reverse in [False, True]:
        entries = [(pair, "pair"), (scalar, "scalar")]
        if reverse:
            entries.reverse()
        value = dict(entries)
        encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
        rows.append({"id": "ascii-reload-" + ("scalar-first" if reverse else "pair-first"),
                     "before": wire(value), "json": encoded, "after": wire(json.loads(encoded))})

    value = {"present": None}
    rows.append({"id": "lookup-presence", "missing": "missing" in value,
                 "present": "present" in value, "missingDefault": wire(value.get("missing", False)),
                 "presentValue": wire(value.get("present", False)), "value": wire(value)})
    return rows


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("python_object_reference_input_rejected\n")
        sys.exit(2)
    executable = Path(sys.executable).resolve()
    modules = [json, json.encoder, json.decoder, json.scanner]
    print(json.dumps({"schemaVersion": 1, "profile": {
        "python": platform.python_version(), "implementation": platform.python_implementation(),
        "platform": sys.platform, "executablePath": str(executable),
        "executableSha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
        "nativeJson": {"origin": _json.__spec__.origin,
                       "sha256": hashlib.sha256(Path(_json.__file__).read_bytes()).hexdigest()
                       if getattr(_json, "__file__", None) else None},
        "stdlib": [{"module": module.__name__, "path": str(Path(module.__file__).resolve()),
                    "sha256": hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()}
                   for module in modules]}, "cases": fixtures()}, ensure_ascii=True))
