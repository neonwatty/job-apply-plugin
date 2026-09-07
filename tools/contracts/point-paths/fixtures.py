"""Independent closed point, record and cache-key recipes."""
ENCODE = [('empty', []), ('nul', [0]), ('scalar', [65536]), ('high', [55296]),
          ('low', [56320]), ('low7f', [56447]), ('escape80', [56448]),
          ('escapeff', [56575]), ('pair', [55296, 56320]), ('high-escape', [55296, 56448]),
          ('adjacent-escapes', [56448, 56575]), ('nul-high', [0, 55296])]
DECODE = [('empty', ''), ('ascii-nul', '610062'), ('max-scalar', 'f48fbfbf'),
          ('scalar', 'f0908080'), ('ff', 'ff'), ('80', '80'), ('overlong2', 'c0af'),
          ('overlong3', 'e08080'), ('surrogate-pair-bytes', 'eda080edb080'),
          ('truncated4', 'f09080'), ('mixed', '61ff62'), ('out-of-range', 'f4908080')]
PARENTS = ('scalar-leaf', 'pair-leaf', 'escape-leaf', 'nul-leaf', 'pair-parent',
           'nul-parent', 'nul-pair-parent', 'outside-parent', 'pair-inside-link',
           'pair-outside-link', 'pair-parent-error', 'pair-root-error',
           'missing-storage', 'missing-file', 'nonstring-file', 'empty-file')
CACHES = ('equal-pair', 'equal-scalar', 'pair-versus-scalar', 'escape-versus-scalar',
          'nul-text', 'empty-text', 'text-versus-numeric', 'expired-pair')
FILE_BYTES = b'synthetic observation bytes'


def text(points):
    return ''.join(map(chr, points))


def typed(value):
    if isinstance(value, str):
        return dict(type='text', points=list(map(ord, value)))
    if isinstance(value, bool):
        return dict(type='bool', value=value)
    if isinstance(value, int):
        return dict(type='int', decimal=str(value))
    if isinstance(value, float):
        return dict(type='float', hex=value.hex())
    raise TypeError('unregistered typed value')


def record(name):
    pair = text([55296, 56320])
    names = {'scalar-leaf': text([65536]), 'pair-leaf': pair,
             'escape-leaf': text([56575]), 'nul-leaf': '\0',
             'pair-parent': pair + '/file.bin', 'nul-parent': '\0/file.bin',
             'nul-pair-parent': '\0' + pair + '/file.bin',
             'outside-parent': '../outside/file.bin', 'pair-inside-link': 'inside/' + pair,
             'pair-outside-link': 'outside-link/' + pair,
             'pair-parent-error': 'file.bin', 'pair-root-error': 'file.bin',
             'nonstring-file': 1, 'empty-file': ''}
    if name == 'missing-storage':
        return {}
    if name == 'missing-file':
        return dict(storageKind='managed')
    return dict(storageKind='managed', managedFile=names[name])


def record_points(value):
    return {key: item if key == 'storageKind' else typed(item) for key, item in value.items()}


def cache_keys(name):
    pair, scalar = [105, 100, 55296, 56320], [105, 100, 65536]
    recipes = {'equal-pair': [pair, pair], 'equal-scalar': [scalar, scalar],
               'pair-versus-scalar': [pair, scalar], 'escape-versus-scalar': [[105, 100, 56575], [105, 100, 255]],
               'nul-text': [[0], [0]], 'empty-text': [[], []],
               'expired-pair': [pair, pair, pair]}
    if name == 'text-versus-numeric':
        return ['1', 1, 1.0, True]
    return [text(points) for points in recipes[name]]
