"""Synthetic-only raw request reference. No Store access or caller input."""
import json
import platform
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "scripts"))
from job_apply_answer_matching import features
from job_apply_answer_matching.scoring import rank_candidates

MAX_INPUT_BYTES = 8192
MAX_DEPTH = 64
MAX_OUTPUT_BYTES = 4096


def error_result(name, message):
    return {"error": {"name": name, "message": message}}


def exceeds_depth(raw):
    """Resource guard only; Python json.loads remains the sole JSON parser."""
    depth = 0
    quoted = False
    escaped = False
    for char in raw:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            if depth > MAX_DEPTH:
                return True
        elif char in "]}":
            depth -= 1
    return False


def evaluate(raw):
    if len(raw.encode("utf-8")) > MAX_INPUT_BYTES:
        return error_result("HarnessLimitError", "input limit exceeded")
    if exceeds_depth(raw):
        return error_result("HarnessLimitError", "depth limit exceeded")
    try:
        request = json.loads(raw)
        if request["operation"] == "features":
            text = request.get("text")
            result = {"tokens": list(features._raw_tokens(text)),
                      "normalized": features._normalized_text(text),
                      "features": sorted(features._features(text)),
                      "negation": features._has_negation(text)}
        else:
            result = rank_candidates(
                question=request.get("question"), scope=request.get("scope"),
                field_class=request.get("fieldClass"),
                sensitivity=request.get("sensitivity"),
                candidates=request.get("candidates"), limit=request.get("limit", 5))
        response = {"result": result}
    except (ValueError, TypeError) as error:
        response = error_result(type(error).__name__, str(error))
    encoded = json.dumps(response, ensure_ascii=True, separators=(",", ":"))
    if len(encoded.encode("ascii")) > MAX_OUTPUT_BYTES:
        return error_result("HarnessLimitError", "output limit exceeded")
    return response


def capture():
    fixtures = json.loads((HERE / "fixtures.json").read_text(encoding="utf-8"))
    cases = []
    for fixture in fixtures:
        response = evaluate(fixture["rawRequest"])
        stdout = json.dumps(response, ensure_ascii=True, separators=(",", ":")) + "\n"
        if "RAW_REFERENCE_SECRET_CANARY" in stdout:
            raise ValueError("reference_privacy_failure")
        cases.append({**fixture, "stdout": stdout})
    return {"schemaVersion": 1,
            "provenance": {"implementation": platform.python_implementation(),
                           "python": platform.python_version(),
                           "unicode": unicodedata.unidata_version,
                           "intMaxStrDigits": sys.get_int_max_str_digits(),
                           "recursionLimit": sys.getrecursionlimit()},
            "cases": cases}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
            raise ValueError("uncontrolled_input")
        print(json.dumps(capture(), ensure_ascii=True))
    except Exception:
        # Unexpected failures never echo request text, executable paths or values.
        sys.stderr.write("raw_reference_failed\n")
        sys.exit(2)
