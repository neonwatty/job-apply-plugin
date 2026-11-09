"""Observe closed point graphs through original Python persistence methods."""
import sys

if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
    sys.stderr.write('point_persistence_reference_input_rejected\n')
    raise SystemExit(2)

import importlib.util
import json
import os
from pathlib import Path
import platform
import tempfile
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
from fixtures import IDS, faults, graph, make
from support import JsonObservation, Operations, digest, error_record, points, snapshot

if os.name != 'posix':
    raise SystemExit('point_persistence_reference_requires_posix')
sys.path.insert(0, str(ROOT / 'scripts'))
from job_apply_store import io
from job_apply_store.domains.coordinator import persistence

MODULES = ('__init__', 'base', 'constants', 'errors', 'io', 'normalization',
           'domains/__init__', 'validation/__init__', 'validation/accounts',
           'validation/extraction', 'validation/jobs_resumes', 'validation/profile_answers',
           'validation/sessions', 'domains/coordinator/__init__', 'domains/coordinator/persistence')


def chunks(identifier):
    traces = []
    for encode in (False, True):
        yielded, successful, error = [], [], None
        try:
            for chunk in json.JSONEncoder(indent=2, sort_keys=True, ensure_ascii=False).iterencode(make(identifier)):
                yielded.append(points(chunk))
                if encode:
                    successful.append(chunk.encode('utf-8').hex())
        except BaseException as caught:
            error = error_record(caught)
        traces.append(dict(yieldedPoints=yielded, successfulHex=successful, error=error)
                      if encode else dict(chunksPoints=yielded, error=error))
    return dict(serializer=traces[0], strictUtf8=traces[1])


def persisted(identifier, root, value):
    target = root / 'private' / 'document.json'
    target.parent.mkdir(parents=True, mode=0o700)
    target.write_bytes(b'{}\n')
    target.chmod(0o600)
    sentinel = root / 'sentinel'
    sentinel.write_bytes(b'sentinel')
    sentinel.chmod(0o600)
    op = Operations(target, faults(identifier))
    before, error, result = snapshot(root), None, None
    try:
        if identifier.startswith('atomic-'):
            io.tempfile.NamedTemporaryFile = op.temporary
            result = io.atomic_write_json(op.Path(target), value, _runtime={'os': op, 'Path': op.Path})
        else:
            def gate(event):
                record = dict(operation='gate', sameObject=event is value)
                op.events.append(record)
                if identifier == 'jsonl-gate-error-pair':
                    raise OSError(5, 'synthetic gate')
                record['result'] = identifier == 'jsonl-gate-hit-pair'
                return record['result']
            persistence._bind_runtime(lambda: {'os': op, 'json': JsonObservation(op.events),
                                              '_set_private_mode': op.chmod})
            result = persistence.CoordinatorPersistenceMixin._append_history_event_idempotent_locked(
                SimpleNamespace(history_path=target, _history_event_is_idempotent_locked=gate), value)
    except BaseException as caught:
        error = error_record(caught)
    finally:
        io.tempfile.NamedTemporaryFile = op.original_temp
    return dict(events=op.events, error=error, result=result, before=before,
                after=snapshot(root, op.temporary_path))


def provenance():
    loaded = []
    for name, module in sorted(sys.modules.copy().items()):
        if module is None:
            continue
        file = getattr(module, '__file__', None)
        origin = getattr(getattr(module, '__spec__', None), 'origin', None)
        if file and Path(file).is_file():
            loaded.append(dict(name=name, file=str(Path(file).resolve()), origin=origin,
                               sha256=digest(Path(file).read_bytes())))
        elif origin == 'built-in':
            loaded.append(dict(name=name, origin=origin))
    executable = Path(sys.executable).resolve()
    return dict(profile=dict(version=sys.version, versionInfo=list(sys.version_info[:3]),
                implementation=platform.python_implementation(), platform=sys.platform,
                machine=platform.machine(), byteorder=sys.byteorder, executable=str(executable),
                executableSha256=digest(executable.read_bytes()), filesystemEncoding=sys.getfilesystemencoding(),
                filesystemErrors=sys.getfilesystemencodeerrors(), isolated=sys.flags.isolated),
                loadedModules=loaded)


cases = []
with tempfile.TemporaryDirectory(prefix='s04-point-persistence-') as owned:
    for identifier in IDS:
        previous = sys.get_int_max_str_digits()
        try:
            sys.set_int_max_str_digits(0)
            value = make(identifier)
            recipe = graph(value)
            limit = 0 if identifier == 'chunk-unlimited641' else 640
            sys.set_int_max_str_digits(limit)
            observation = chunks(identifier) if identifier.startswith('chunk-') else persisted(identifier, Path(owned) / identifier, value)
            cases.append(dict(id=identifier, operation=identifier.split('-')[0], inputGraph=recipe,
                              intMaxStrDigits=limit, faults=faults(identifier), **observation))
        finally:
            sys.set_int_max_str_digits(previous)
    source = [dict(path='scripts/job_apply_store/' + name + '.py',
                   sha256=digest((ROOT / 'scripts/job_apply_store' / (name + '.py')).read_bytes())) for name in MODULES]
    source += [dict(path=str(path.relative_to(ROOT)), sha256=digest(path.read_bytes()))
               for path in (HERE / 'reference.py', HERE / 'fixtures.py', HERE / 'support.py')]
    output = dict(schemaVersion=1, scope='owned-point-persistence-reference',
                  sourceProvenance=source, cases=cases, **provenance())
    print(json.dumps(output, ensure_ascii=True, separators=(',', ':')))
