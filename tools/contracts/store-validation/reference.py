"""Fixed synthetic document validation oracle; no Store or caller inputs."""

import json
import platform
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from job_apply_store.constants import SCHEMA_VERSION
from job_apply_store.errors import StoreError
from job_apply_store.io import require_object, validate_version


def capture():
    raw_values = [
        "null", "true", "1", "1.0", '"text"', "[]", "{}",
        '{"schemaVersion":null}', '{"schemaVersion":true}',
        '{"schemaVersion":false}', '{"schemaVersion":1}',
        '{"schemaVersion":1.0}', '{"schemaVersion":1e0}',
        '{"schemaVersion":0}', '{"schemaVersion":-1}',
        '{"schemaVersion":2}', '{"schemaVersion":9007199254740993}',
        '{"schemaVersion":-9007199254740993}',
        '{"schemaVersion":NaN}', '{"schemaVersion":Infinity}',
        '{"schemaVersion":"1"}', '{"schemaVersion":{}}',
        '{"schemaVersion":[]}', '{"schemaVersion":true,"schemaVersion":1}',
        '{"schemaVersion":1,"schemaVersion":true}',
        '{"schemaVersion":1,"unrecognized":false}',
    ]
    cases = []
    for raw in raw_values:
        for label in ["profile", "", "synthetic\nlabel"]:
            value = json.loads(raw)
            try:
                document = require_object(value, label)
                validate_version(document, label)
                outcome = {"ok": True}
            except StoreError as error:
                outcome = {"ok": False, "message": str(error)}
            cases.append({"raw": raw, "label": label, "outcome": outcome})
    return {"python": platform.python_version(), "schemaVersion": SCHEMA_VERSION,
            "cases": cases}


if __name__ == "__main__":
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write("reference_input_rejected\n")
        sys.exit(2)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
