"""Fixed binary64 timestamp reference; no caller/live files or Store state are mutated."""
import hashlib
import json
from pathlib import Path
import platform
import os
import tempfile
import struct
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts'))
from job_apply_store.normalization import _resume_modified_at

CASES = [
    ('zero', 0.0), ('negative-zero', -0.0), ('one', 1.0), ('negative-one', -1.0),
    ('below-carry', 0.9999994), ('half-carry', 0.9999995), ('above-carry', 0.9999996),
    ('negative-small', -0.0000004), ('negative-half', -0.0000005), ('negative-round', -0.0000006),
    ('negative-below-second', -1.0000004), ('negative-past-second', -1.0000006),
    ('recent-below-carry', 1767225600.9999994), ('recent-half-carry', 1767225600.9999995),
    ('recent-above-carry', 1767225600.9999996), ('minimum-year', -62135596800.0),
    ('before-minimum-year', -62135596801.0), ('last-second', 253402300799.0),
    ('after-maximum-year', 253402300800.0), ('large-positive', 1e30), ('large-negative', -1e30),
    ('nan', float('nan')), ('positive-infinity', float('inf')), ('negative-infinity', -float('inf')),
]


def native_cases():
    rows = []
    with tempfile.TemporaryDirectory(prefix='resume-time-reference-') as temporary:
        path = Path(temporary) / 'synthetic.bin'
        path.write_bytes(b'synthetic')
        for nanoseconds in [1767225600999999400, 1767225600999999500,
                            1767225600999999600, -600]:
            os.utime(path, ns=(nanoseconds, nanoseconds))
            before = path.stat()
            value = _resume_modified_at(before)
            after = path.stat()
            rows.append({'requestedNs': str(nanoseconds), 'actualNs': str(before.st_mtime_ns),
                         'secondsHex': struct.pack('>d', before.st_mtime).hex(), 'value': value,
                         'unchanged': (before.st_mtime_ns, before.st_mode, before.st_size)
                         == (after.st_mtime_ns, after.st_mode, after.st_size)
                         and path.read_bytes() == b'synthetic'})
    return rows


def capture():
    rows = []
    for identifier, seconds in CASES:
        try:
            outcome = {'kind': 'value', 'value': _resume_modified_at(SimpleNamespace(st_mtime=seconds))}
        except Exception as error:
            outcome = {'kind': 'error', 'name': type(error).__name__}
        rows.append({'id': identifier, 'secondsHex': struct.pack('>d', seconds).hex(), 'outcome': outcome})
    source = ROOT / 'scripts/job_apply_store/normalization.py'
    return {'schemaVersion': 1, 'profile': {'python': platform.python_version(),
            'implementation': platform.python_implementation(), 'platform': sys.platform},
            'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'cases': rows,
            'nativeCases': native_cases()}


if __name__ == '__main__':
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write('resume_modified_at_reference_input_rejected\n')
        sys.exit(2)
    print(json.dumps(capture(), ensure_ascii=True, allow_nan=False))
