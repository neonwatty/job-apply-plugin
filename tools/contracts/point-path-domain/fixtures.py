"""Fixed independently allocated domain recipes, never derived from TS output."""
FILE_BYTES = b'synthetic observation bytes'
FILE_REFS = ['none', 'true', 'false', 'int-zero', 'int-huge', 'float-negative-zero',
             'float-fraction-a', 'nan-a', 'positive-inf-a', 'negative-inf-a', 'list', 'dict']
FILE_IDS = ['null', 'true', 'false', 'int-zero', 'int-huge', 'float-zero',
            'float-fraction', 'float-nan', 'float-positive-infinity',
            'float-negative-infinity', 'list', 'dict']
SEQUENCES = [
    ('null', ['none', 'none', 'false']),
    ('zero', ['false', 'int-zero', 'float-zero', 'float-negative-zero']),
    ('fraction', ['float-fraction-a', 'float-fraction-b', 'int-one']),
    ('infinity', ['positive-inf-a', 'positive-inf-b', 'negative-inf-a', 'negative-inf-b']),
    ('exact-large', ['int-exact', 'float-exact', 'int-rounded-neighbor', 'float-rounded-neighbor']),
    ('integer-beyond-float', ['int-huge', 'positive-inf-a', 'int-negative-huge', 'negative-inf-a']),
    ('nan-same', ['nan-a', 'nan-a']),
    ('nan-distinct', ['nan-a', 'nan-b', 'nan-a', 'nan-b']),
    ('negative', ['int-negative-one', 'float-negative-one', 'int-negative-two']),
]


def values():
    return {'none': None, 'true': True, 'false': False, 'int-zero': 0, 'int-one': 1,
            'int-negative-one': -1, 'int-negative-two': -2,
            'int-huge': 2**1024, 'int-negative-huge': -(2**1024),
            'int-exact': 2**53, 'int-rounded-neighbor': 2**53 + 1,
            'float-zero': float.fromhex('0x0.0p+0'), 'float-negative-zero': float.fromhex('-0x0.0p+0'),
            'float-fraction-a': float.fromhex('0x1.8000000000000p+0'), 'float-fraction-b': float.fromhex('0x1.8000000000000p+0'),
            'float-exact': float.fromhex('0x1.0000000000000p+53'), 'float-rounded-neighbor': float.fromhex('0x1.0000000000000p+53'),
            'float-negative-one': float.fromhex('-0x1.0000000000000p+0'), 'positive-inf-a': float('inf'),
            'positive-inf-b': float('inf'), 'negative-inf-a': float('-inf'),
            'negative-inf-b': float('-inf'), 'nan-a': float('nan'), 'nan-b': float('nan'),
            'list': [], 'dict': {}}


def recipes():
    rows = [dict(id='domain-file-' + name, kind='file', file_ref=ref)
            for name, ref in zip(FILE_IDS, FILE_REFS)]
    rows += [dict(id='domain-cache-' + name, kind='sequence', refs=refs)
             for name, refs in SEQUENCES]
    rows += [dict(id='domain-cache-' + mode + '-' + kind, kind='timing',
                  refs=[kind], mode=mode)
             for kind in ['list', 'dict'] for mode in ['active', 'omitted', 'missing', 'null-identity']]
    rows += [dict(id='domain-id-missing-' + mode, kind='missing-id', mode=mode)
             for mode in ['regular', 'leaf', 'invalid-file']]
    return rows
