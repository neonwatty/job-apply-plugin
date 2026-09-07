"""Fixed synthetic HTTP bodies and codepoint-preserving receipts."""
import io


def fixtures():
    rows = []

    def add(name, body, **options):
        rows.append({'id': name, 'body': body, **options})

    high = bytes.fromhex('eda080')
    low = bytes.fromhex('edb080')
    scalar = bytes.fromhex('f0908080')
    for name, value in [('raw-pair', high + low), ('escaped-pair', b'\\ud800\\udc00'),
                        ('scalar', scalar), ('raw-high', high), ('raw-low', low),
                        ('escaped-high', b'\\ud800'), ('escaped-low', b'\\udc00'),
                        ('raw-high-escaped-low', high + b'\\udc00'),
                        ('escaped-high-raw-low', b'\\ud800' + low)]:
        add(name, b'{"x":"' + value + b'"}')
    add('pair-scalar-keys', b'{"' + high + low + b'":1,"' + scalar + b'":2}')
    add('escaped-scalar-keys', b'{"\\ud800\\udc00":1,"' + scalar + b'":2}')
    add('raw-escaped-pair-keys', b'{"' + high + low + b'":1,"\\ud800\\udc00":2}')
    text = '{"x":"\U00010000"}'
    for encoding in ('utf-8-sig', 'utf-16', 'utf-16-le', 'utf-16-be', 'utf-32', 'utf-32-le', 'utf-32-be'):
        add(encoding, text.encode(encoding))
    add('utf16-lone-high', bytes.fromhex('fffe7b002200780022003a00220000d822007d00'))
    add('utf32-lone-high', bytes.fromhex('fffe00007b0000002200000078000000220000003a0000002200000000d80000220000007d000000'))
    for name, body in [('invalid-ff', b'{"x":"\xff"}'), ('overlong', b'{"x":"\xc0\x80"}'),
                       ('truncated-utf8', b'{"x":"\xe2\x82"}'), ('invalid-utf32', b'\xff\xfe\x00\x00\x00\x00\x11\x00'),
                       ('odd-utf16', b'\xff\xfe{'), ('invalid-json', b'{"x":}'),
                       ('array', b'[]'), ('empty', b'')]:
        add(name, body)
    add('wrong-content-type', b'{}', contentType='application/json; charset=utf-8')
    add('missing-length', b'{}', length=None)
    add('malformed-length', b'{}', length='bad')
    add('negative-length', b'{}', length='-1')
    add('oversize', b'{}', length='65537')
    add('length-whitespace-plus', b'{}', length=' +2 ')
    add('length-short', b'{}tail', length='2')
    add('length-long', b'{}', length='99')
    add('short-read', b'{"x":1}', readLimit=2)
    add('read-error', b'{}', readError=True)
    return rows


def wire(value):
    if value is None:
        return {'kind': 'null'}
    if isinstance(value, bool):
        return {'kind': 'bool', 'value': value}
    if isinstance(value, str):
        return {'kind': 'string', 'codepoints': list(map(ord, value))}
    if isinstance(value, int):
        return {'kind': 'int', 'decimal': str(value)}
    if isinstance(value, list):
        return {'kind': 'list', 'values': [wire(item) for item in value]}
    if isinstance(value, dict):
        return {'kind': 'object', 'entries': [
            {'key': list(map(ord, key)), 'value': wire(item)} for key, item in value.items()]}
    raise AssertionError('unhandled synthetic value')


class Request:
    def __init__(self, row):
        self.headers = {'Content-Type': row.get('contentType', 'application/json')}
        length = row.get('length', str(len(row['body'])))
        if length is not None:
            self.headers['Content-Length'] = length
        self.stream = io.BytesIO(row['body'])
        self.rfile = self
        self.row = row
        self.reads = []
        self.errors = []

    def read(self, size):
        self.reads.append(size)
        if self.row.get('readError'):
            raise OSError(5, 'synthetic read')
        return self.stream.read(min(size, self.row.get('readLimit', size)))

    def _error(self, status, message):
        self.errors.append({'status': int(status), 'message': message})
