"""Closed synthetic graph constructors, independent of expected-output data."""
CHUNKS = ('scalar', 'pair', 'high', 'low', 'surrogate-run', 'controls',
          'pair-value', 'pair-key', 'key-order', 'empty-nested', 'shared', 'cycle',
          'invalid-key', 'bad-before-cycle', 'bad-before-integer',
          'integer640', 'integer641', 'unlimited641')
ATOMIC = ('scalar', 'pair', 'pair-key', 'prefix-pair', 'pair-before-cycle',
          'pair-before-integer', 'pair-close', 'pair-cleanup', 'pair-close-cleanup',
          'installed-mode-error')
JSONL = ('scalar', 'pair', 'pair-key', 'pair-before-cycle', 'pair-before-integer',
         'gate-hit-pair', 'gate-error-pair', 'controls')
IDS = tuple('chunk-' + name for name in CHUNKS) + tuple('atomic-' + name for name in ATOMIC) + tuple('jsonl-' + name for name in JSONL)


def make(identifier):
    scalar, pair = chr(65536), chr(55296) + chr(56320)
    controls = ''.join(map(chr, [0, 10, 9, 34, 92, 127]))
    # Arithmetic construction cannot trip the very conversion limit under test.
    large = (10 ** 641 - 1) // 9
    cycle = []
    cycle.append(cycle)
    if identifier == 'chunk-shared':
        child = [scalar]
        return [child, child]
    fixed = {'chunk-scalar': scalar, 'chunk-pair': pair, 'chunk-high': chr(55296),
             'chunk-low': chr(56320), 'chunk-surrogate-run': pair + chr(56448),
             'chunk-controls': controls, 'chunk-pair-value': {'a': pair},
             'chunk-key-order': {scalar: 2, pair: 1, '': 0},
             'chunk-empty-nested': [{}, [], {'a': []}], 'chunk-cycle': cycle,
             'chunk-invalid-key': {'a': 1, 1: 2}, 'chunk-integer640': (10 ** 640 - 1) // 9,
             'chunk-integer641': large, 'chunk-unlimited641': large,
             'atomic-prefix-pair': {'a': 'ok', 'z': pair}}
    if identifier in fixed:
        return fixed[identifier]
    if identifier.endswith(('before-cycle',)):
        return [pair, cycle]
    if identifier.endswith(('before-integer',)):
        return [pair, large]
    if identifier.endswith('pair-key'):
        return {pair: 1}
    if identifier.endswith('controls'):
        return {'a': controls}
    if identifier in IDS:
        return {'a': scalar if identifier.endswith(('scalar', 'installed-mode-error')) else pair}
    raise ValueError('unregistered fixture')


def graph(value, labels=None):
    """Typed point projection; identity labels retain only actual shared/cyclic lists."""
    labels = {} if labels is None else labels
    if isinstance(value, str):
        return dict(type='text', points=list(map(ord, value)))
    if isinstance(value, int):
        return dict(type='int', decimal=str(value))
    if isinstance(value, dict):
        return dict(type='object', entries=[[graph(k, labels), graph(v, labels)] for k, v in value.items()])
    if isinstance(value, list):
        if id(value) in labels:
            return dict(ref=labels[id(value)])
        label = 'cycle' if value and value[0] is value else 'child' if len(value) == 1 and isinstance(value[0], str) else None
        if label:
            labels[id(value)] = label
        row = dict(type='array', items=[graph(item, labels) for item in value])
        if label:
            row['id'] = label
        return row
    raise TypeError('unregistered graph type')


def faults(identifier):
    return (['close'] if 'close' in identifier else []) + (['unlink'] if 'cleanup' in identifier else []) + (['target-chmod'] if identifier.endswith('installed-mode-error') else [])
