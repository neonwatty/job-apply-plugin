"""Fixed composed JSON observations; caller input and Store access are forbidden."""
import hashlib
import importlib
import json
from pathlib import Path
import platform
import sys


def points(text):
    return list(map(ord, text))


PAIR = [0xd800, 0xdc00]
SCALAR = [0x10000]
ESCAPED = points(r'\ud800\udc00')


def quoted(content):
    return [34, *content, 34]


FIXTURES = [
    ('raw-pair', quoted(PAIR)), ('scalar', quoted(SCALAR)),
    ('escaped-pair', quoted(ESCAPED)),
    ('raw-high-escaped-low', quoted([0xd800, *points(r'\udc00')])),
    ('escaped-high-raw-low', quoted([*points(r'\ud800'), 0xdc00])),
    ('separated-escapes', quoted(points(r'\ud800X\udc00'))),
    ('escaped-backslash', quoted(points(r'\\ud800\\udc00'))),
    ('lone-high', quoted([0xd800])), ('lone-low', quoted([0xdc00])),
    ('reverse-pair', quoted([0xdc00, 0xd800])),
    ('maximum-escaped', quoted(points(r'\uDBFF\uDFFF'))),
    ('key-pair-scalar-overwrite', [*points('{"'), *PAIR,
        *points('\":1,"'), *SCALAR, *points('\":2,"'), *ESCAPED, *points('\":3.0}')]),
    ('mixed-key-overwrite', [*points('{"'), *PAIR, *points('\":1,"'),
        0xd800, *points(r'\udc00'), *points('\":2,"x":true}')]),
    ('key-sort-boundaries', [*points('{"'), 0x10ffff, *points('\":6,"'),
        0x10000, *points('\":5,"'), 0xe000, *points('\":4,"'), 0xdc00,
        *points('\":3,"'), 0xd800, *points('\":2,"'), 0xd7ff, *points('\":1}')]),
    ('numeric-composition', [*points('["'), *PAIR,
        *points('\",9007199254740993,1.0,-0.0,1e999,-1e999,NaN,true,false,null]')]),
    ('shared-text-values', [*points('["'), *PAIR, *points('\",{"x":"'), *SCALAR, *points('\"}]')]),
    ('integer-limit-accepted', points('9' * 640)),
    ('integer-limit-rejected', points('9' * 641)),
    ('bad-after-pair', [*points('["'), *PAIR, *points('\",?]')]),
    ('bad-after-scalar', [*points('["'), *SCALAR, *points('\",?]')]),
    ('bad-after-escaped-pair', points(r'["\ud800\udc00",?]')),
    ('bad-multiline', [*points('[\n"'), *PAIR, *points('\",\n?]')]),
    ('bad-key-colon', [*points('{"'), *PAIR, *points('\" 1}')]),
    ('bad-escape', [34, *PAIR, *points(r'\q'), 34]),
    ('bad-unicode-escape', [34, *PAIR, *points(r'\u12x4'), 34]),
    ('bad-control', [34, *PAIR, 1, 34]),
    ('unterminated', [34, *PAIR]),
    ('extra-data', [34, *PAIR, 34, 32, 48]),
    ('text-bom', [0xfeff, *points('{}')]),
    ('trailing-comma', points('[1,]')),
    ('missing-value', points('{"x":}')),
    ('empty', []),
]
BYTE_FIXTURES = [
    ('bytes-raw-pair', '22eda080edb08022'),
    ('bytes-scalar', '22f090808022'),
    ('bytes-escaped-pair', '225c75643830305c756463303022'),
    ('bytes-utf8-bom', 'efbbbf22eda080edb08022'),
    ('bytes-utf16-pair', 'fffe220000d800dc2200'),
    ('bytes-utf32-pair', 'fffe00002200000000d8000000dc000022000000'),
]


def typed(value):
    if value is None:
        return {'kind': 'null'}
    if isinstance(value, bool):
        return {'kind': 'boolean', 'value': value}
    if isinstance(value, str):
        return {'kind': 'text', 'points': points(value)}
    if isinstance(value, int):
        return {'kind': 'integer', 'decimal': str(value)}
    if isinstance(value, float):
        return {'kind': 'float', 'hex': value.hex()}
    if isinstance(value, list):
        return {'kind': 'array', 'items': [typed(item) for item in value]}
    return {'kind': 'object', 'entries': [[points(key), typed(item)] for key, item in value.items()]}


def serialize(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'))


def capture(identifier, document, input_hex=None, encoding=None):
    row = {'id': identifier, 'documentPoints': points(document),
           'inputHex': input_hex, 'detectedEncoding': encoding}
    try:
        value = json.loads(document)
        ascii_text = serialize(value)
        row['outcome'] = {'kind': 'value', 'value': typed(value), 'ascii': ascii_text,
                          'asciiReload': typed(json.loads(ascii_text))}
    except json.JSONDecodeError as error:
        row['outcome'] = {'kind': 'error', 'name': 'JSONDecodeError', 'message': str(error),
            'reason': error.msg, 'position': error.pos, 'line': error.lineno,
            'column': error.colno, 'documentPoints': points(error.doc)}
    except ValueError as error:
        row['outcome'] = {'kind': 'error', 'name': type(error).__name__, 'message': str(error)}
    return row


def serializer_cases():
    child = [chr(0xd800) + chr(0xdc00)]
    shared = [child, child]
    array = []
    array.append(array)
    mapping = {}
    mapping['self'] = mapping
    result = []
    for identifier, value in [('shared-array', shared), ('cycle-array', array), ('cycle-object', mapping)]:
        try:
            outcome = {'kind': 'value', 'ascii': serialize(value), 'value': typed(value),
                       'sameChildIdentity': value[0] is value[1]}
        except ValueError as error:
            outcome = {'kind': 'error', 'name': type(error).__name__, 'message': str(error)}
        result.append({'id': identifier, 'outcome': outcome})
    return result


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


if __name__ == '__main__':
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write('codepoint_json_reference_input_rejected\n')
        sys.exit(2)
    sys.set_int_max_str_digits(640)
    rows = [capture(identifier, ''.join(map(chr, data))) for identifier, data in FIXTURES]
    for identifier, hexadecimal in BYTE_FIXTURES:
        data = bytes.fromhex(hexadecimal)
        encoding = json.detect_encoding(data)
        rows.append(capture(identifier, data.decode(encoding, 'surrogatepass'), hexadecimal, encoding))
    names = ['json', 'json.decoder', 'json.encoder', 'json.scanner', 'codecs',
             'encodings', 'encodings.utf_8', 'encodings.utf_8_sig', 'encodings.utf_16', 'encodings.utf_32']
    stdlib = {}
    for name in names:
        path = str(Path(importlib.import_module(name).__file__).resolve())
        stdlib[name] = {'path': path, 'sha256': digest(path)}
    native = {}
    for name in ['_json', '_codecs']:
        origin = importlib.import_module(name).__spec__.origin
        native[name] = {'origin': origin, 'sha256': None if origin == 'built-in' else digest(origin)}
    print(json.dumps({'schemaVersion': 1, 'scope': 'fixed-composed-codepoint-json',
        'profile': {'python': platform.python_version(), 'implementation': platform.python_implementation(),
            'platform': sys.platform, 'byteOrder': sys.byteorder, 'intMaxStrDigits': sys.get_int_max_str_digits(),
            'executablePath': str(Path(sys.executable).resolve()), 'executableSha256': digest(sys.executable)},
        'stdlib': stdlib, 'native': native, 'cases': rows, 'serializers': serializer_cases()}, ensure_ascii=True))
