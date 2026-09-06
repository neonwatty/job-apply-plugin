#!/usr/bin/env python3
"""Actual HTTP JSON method, canonical helper and persisted encoding expression."""
import ast
import _json
import hashlib
from http import HTTPStatus
import json
import json.decoder
import json.encoder
import json.scanner
from pathlib import Path
import platform
import sys
from typing import Any

sys.dont_write_bytecode = True
if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
    sys.stderr.write('http_json_bytes_input_rejected\n')
    raise SystemExit(2)
sys.path.insert(0, str(Path(__file__).parent))
from support import Request, fixtures, wire

ROOT = Path(__file__).resolve().parents[3]
PATHS = ['scripts/job_apply_workspace/http.py', 'scripts/job_apply_workspace/__init__.py',
         'scripts/job_apply_store/normalization.py',
         'scripts/job_apply_store/domains/coordinator/persistence.py']


def tree(path):
    return ast.parse((ROOT / path).read_text(encoding='utf8'))


def named_function(parsed, name):
    matches = [node for node in ast.walk(parsed) if isinstance(node, ast.FunctionDef) and node.name == name]
    assert len(matches) == 1
    return matches[0]


constants = tree(PATHS[1])
body_limit = next(node.value for node in constants.body if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == 'MAX_BODY_BYTES' for target in node.targets))
assert isinstance(body_limit, ast.BinOp) and isinstance(body_limit.op, ast.Mult)
assert isinstance(body_limit.left, ast.Constant) and isinstance(body_limit.right, ast.Constant)
maximum = body_limit.left.value * body_limit.right.value
http_method = named_function(tree(PATHS[0]), '_read_json')
canonical_method = named_function(tree(PATHS[2]), '_canonical_json')
append_method = named_function(tree(PATHS[3]), '_append_history_event_idempotent_locked')
encoding = [node for node in append_method.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'encoded' for target in node.targets)]
assert len(encoding) == 1
namespace = {'json': json, 'HTTPStatus': HTTPStatus, 'MAX_BODY_BYTES': maximum, 'Any': Any}
for method in (http_method, canonical_method):
    exec(compile(ast.Module(body=[method], type_ignores=[]), 'bound_production_method', 'exec'), namespace)
encoding_code = compile(ast.Module(body=encoding, type_ignores=[]), 'bound_production_encoding', 'exec')


def error_info(error):
    if isinstance(error, UnicodeEncodeError):
        return {'name': type(error).__name__, 'encoding': error.encoding,
                'start': error.start, 'end': error.end, 'reason': error.reason,
                'objectCodepoints': list(map(ord, error.object))}
    return {'name': type(error).__name__, 'errno': getattr(error, 'errno', None)}


def capture(row):
    request = Request(row)
    try:
        value = namespace['_read_json'](request)
        outcome = {'kind': 'value', 'value': wire(value)}
    except Exception as error:
        value = None
        outcome = {'kind': 'error', 'error': error_info(error)}
    downstream = None
    if isinstance(value, dict):
        canonical = namespace['_canonical_json'](value)
        scope = {'runtime_json': json, 'event': value}
        try:
            exec(encoding_code, scope)
            encoded = {'kind': 'bytes', 'hex': scope['encoded'].hex()}
        except Exception as error:
            encoded = {'kind': 'error', 'error': error_info(error)}
        downstream = {'canonicalCodepoints': list(map(ord, canonical)), 'persisted': encoded}
    return {'id': row['id'], 'inputHex': row['body'].hex(), 'headers': request.headers,
            'readLimit': row.get('readLimit'), 'readError': row.get('readError', False),
            'reads': request.reads, 'remainingHex': request.stream.read().hex(),
            'httpErrors': request.errors, 'outcome': outcome, 'downstream': downstream}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


print(json.dumps({'schemaVersion': 1, 'scope': 'extracted-production-methods-no-route-integration',
                  'profile': {'implementation': platform.python_implementation(),
                              'python': platform.python_version(), 'platform': sys.platform,
                              'byteorder': sys.byteorder,
                              'executable': str(Path(sys.executable).resolve()),
                              'executableSha256': digest(Path(sys.executable).resolve()),
                              'nativeJson': {'origin': _json.__spec__.origin,
                                             'sha256': digest(_json.__spec__.origin)
                                             if _json.__spec__.origin != 'built-in' else None}},
                  'sourceHashes': {path: digest(ROOT / path) for path in PATHS},
                  'stdlibHashes': {name: digest(module.__file__) for name, module in
                                   [('json', json), ('json.decoder', json.decoder),
                                    ('json.encoder', json.encoder), ('json.scanner', json.scanner)]},
                  'maxBodyBytes': maximum, 'cases': [capture(row) for row in fixtures()]}, sort_keys=True))
