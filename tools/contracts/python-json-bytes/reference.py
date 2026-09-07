"""Fixed byte decoding before JSON parsing; no HTTP handler, Store or caller input."""
import codecs
import hashlib
import importlib
import json
from pathlib import Path
import platform
import sys

FIXTURES = {
    'empty': '', 'ascii': '7b2278223a317d', 'one-ascii': '41', 'one-zero': '00',
    'two-ascii': '4142', 'two-be': '0041', 'two-le': '4100', 'two-zero': '0000',
    'three-be-looking': '000041', 'three-le-looking': '410000',
    'four-be16': '00410042', 'four-le16': '41004200',
    'four-be32': '00000041', 'four-le32': '41000000', 'four-zero': '00000000',
    'utf8-bom-only': 'efbbbf', 'utf16-le-bom-only': 'fffe', 'utf16-be-bom-only': 'feff',
    'utf32-le-bom-only': 'fffe0000', 'utf32-be-bom-only': '0000feff',
    'utf8-bom-json': 'efbbbf7b7d', 'utf16-le-bom-json': 'fffe7b007d00',
    'utf16-be-bom-json': 'feff007b007d', 'utf32-le-bom-json': 'fffe00007b0000007d000000',
    'utf32-be-bom-json': '0000feff0000007b0000007d',
    'utf8-scalar-boundaries': '7fc280dfbfe0a080efbfbff0908080f48fbfbf',
    'utf16-le-max-scalar': 'fffeffdbffdf', 'utf16-be-max-scalar': 'feffdbffdfff',
    'utf32-le-max-scalar': 'fffe0000ffff1000', 'utf32-be-max-scalar': '0000feff0010ffff',
    'utf8-scalar': 'f0908080', 'utf8-raw-pair': 'eda080edb080',
    'utf8-high': 'eda080', 'utf8-low': 'edb080',
    'json-scalar': '7b2278223a22f0908080227d',
    'json-raw-pair': '7b2278223a22eda080edb080227d',
    'json-escaped-pair': '7b2278223a225c75643830305c7564633030227d',
    'json-raw-high-escaped-low': '7b2278223a22eda0805c7564633030227d',
    'json-escaped-high-raw-low': '7b2278223a225c7564383030edb080227d',
    'json-pair-scalar-keys': '7b22eda080edb080223a312c22f0908080223a327d',
    'utf16-le-pair': 'fffe00d800dc', 'utf16-be-pair': 'feffd800dc00',
    'utf16-le-high': 'fffe00d8', 'utf16-be-low': 'feffdc00',
    'utf16-le-high-ascii': 'fffe00d84100', 'utf16-be-two-highs': 'feffd800d801',
    'utf32-le-pair': 'fffe000000d8000000dc0000',
    'utf32-be-pair': '0000feff0000d8000000dc00',
    'utf32-le-scalar': 'fffe000000000100', 'utf32-be-scalar': '0000feff00010000',
    'utf32-le-high': 'fffe000000d80000', 'utf32-be-low': '0000feff0000dc00',
    'partial-utf8-bom': 'efbb', 'single-ff': 'ff', 'single-fe': 'fe',
    'utf8-continuation': '80', 'utf8-overlong-two': 'c0af', 'utf8-overlong-three': 'e08080',
    'utf8-overlong-four': 'f0808080', 'utf8-truncated': 'e282',
    'utf8-truncated-surrogate': 'eda0', 'utf8-bad-continuation': 'e228a1',
    'utf8-above-max': 'f4908080', 'utf8-scalar-then-bad': 'f0908080ff',
    'utf8-bom-then-bad': 'efbbbfff', 'utf8-surrogate-then-bad': 'eda080ff',
    'utf16-le-odd': 'fffe41', 'utf16-be-odd': 'feff00',
    'utf16-le-high-odd': 'fffe00d841', 'utf16-be-high-odd': 'feffd80000',
    'utf16-le-inferred-odd': '4100420043', 'utf16-be-inferred-odd': '0041004200',
    'utf32-le-truncated': 'fffe0000410000', 'utf32-be-truncated': '0000feff000041',
    'utf32-le-above-max': 'fffe000000001100', 'utf32-be-above-max': '0000feff00110000',
    'utf32-le-inferred-above-max': '4100000000001100',
    'utf32-be-inferred-above-max': '0000004100110000',
    'utf32-le-scalar-then-truncated': 'fffe00000000010041',
    'utf8-interior-bom': '41efbbbf', 'utf16-interior-bom': 'fffe4100fffe',
    'utf32-interior-bom': '0000feff000000410000feff',
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def capture(identifier, hexadecimal):
    data = bytes.fromhex(hexadecimal)
    encoding = json.detect_encoding(data)
    try:
        decoded = data.decode(encoding, 'surrogatepass')
        outcome = {'kind': 'text', 'codepoints': list(map(ord, decoded)), 'length': len(decoded)}
    except UnicodeDecodeError as error:
        outcome = {'kind': 'error', 'name': type(error).__name__, 'encoding': error.encoding,
                   'objectHex': error.object.hex(), 'start': error.start, 'end': error.end,
                   'reason': error.reason, 'message': str(error)}
    return {'id': identifier, 'inputHex': hexadecimal, 'detectedEncoding': encoding, 'outcome': outcome}


if __name__ == '__main__':
    if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
        sys.stderr.write('python_json_bytes_reference_input_rejected\n')
        sys.exit(2)
    rows = [capture(identifier, hexadecimal) for identifier, hexadecimal in FIXTURES.items()]
    names = ['json', 'codecs', 'encodings', 'encodings.utf_8', 'encodings.utf_8_sig',
             'encodings.utf_16', 'encodings.utf_16_le', 'encodings.utf_16_be',
             'encodings.utf_32', 'encodings.utf_32_le', 'encodings.utf_32_be']
    stdlib = {}
    for name in names:
        module = importlib.import_module(name)
        path = str(Path(module.__file__).resolve())
        stdlib[name] = {'path': path, 'sha256': digest(path)}
    native = importlib.import_module('_codecs')
    origin = native.__spec__.origin
    print(json.dumps({'schemaVersion': 1, 'scope': 'detect-encoding-and-surrogatepass-decode-only',
        'profile': {'python': platform.python_version(), 'implementation': platform.python_implementation(),
                    'platform': sys.platform, 'byteOrder': sys.byteorder,
                    'executablePath': str(Path(sys.executable).resolve()),
                    'executableSha256': digest(sys.executable)},
        'stdlib': stdlib, 'nativeCodecs': {'origin': origin,
            'sha256': None if origin == 'built-in' else digest(origin)},
        'cases': rows}, ensure_ascii=True))
