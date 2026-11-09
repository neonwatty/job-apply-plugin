"""Fixed codec, parent-order and actual cache reference; no public Store."""
import sys

if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
    sys.stderr.write('point_paths_reference_input_rejected\n')
    raise SystemExit(2)

import json
import os
from pathlib import Path
import platform
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
from fixtures import ENCODE, DECODE, PARENTS, CACHES, text
from support import cache_case, digest, error_record, parent_case, points

if os.name != 'posix':
    raise SystemExit('point_paths_reference_requires_posix')
sys.path.insert(0, str(ROOT / 'scripts'))
from job_apply_store import constants, normalization
from job_apply_store.domains.resumes import storage

MODULES = ('__init__', 'base', 'constants', 'errors', 'io', 'normalization',
           'domains/__init__', 'validation/__init__', 'validation/accounts',
           'validation/extraction', 'validation/jobs_resumes', 'validation/profile_answers',
           'validation/sessions', 'domains/resumes/__init__', 'domains/resumes/storage')


def codec_cases():
    result = []
    for name, value in ENCODE:
        output, caught = None, None
        try:
            output = os.fsencode(text(value)).hex()
        except UnicodeError as error:
            caught = error_record(error)
        result.append(dict(id='encode-' + name, operation='os.fsencode', inputPoints=value,
                           outputHex=output, error=caught))
    for name, value in DECODE:
        output, caught = None, None
        try:
            output = points(os.fsdecode(bytes.fromhex(value)))
        except UnicodeError as error:
            caught = error_record(error)
        result.append(dict(id='decode-' + name, operation='os.fsdecode', inputHex=value,
                           outputPoints=output, error=caught))
    return result


def provenance():
    loaded = []
    for name, module in sorted(sys.modules.copy().items()):
        if module is None:
            continue
        file = getattr(module, '__file__', None)
        origin = getattr(getattr(module, '__spec__', None), 'origin', None)
        if file and Path(file).is_file():
            row = dict(name=name, origin=origin, sha256=digest(Path(file).read_bytes()))
            resolved = str(Path(file).resolve())
            if resolved != origin:
                row['file'] = resolved
            loaded.append(row)
        elif origin == 'built-in':
            loaded.append(dict(name=name, origin=origin))
    executable = Path(sys.executable).resolve()
    return dict(profile=dict(version=sys.version, versionInfo=list(sys.version_info[:3]),
                implementation=platform.python_implementation(), platform=sys.platform,
                machine=platform.machine(), byteorder=sys.byteorder, executable=str(executable),
                executableSha256=digest(executable.read_bytes()), filesystemEncoding=sys.getfilesystemencoding(),
                filesystemErrors=sys.getfilesystemencodeerrors(), isolated=sys.flags.isolated),
                loadedModules=loaded)


with tempfile.TemporaryDirectory(prefix='s05-point-paths-') as owned:
    cases = codec_cases()
    cases += [parent_case(name, Path(owned) / ('managed-' + name), storage) for name in PARENTS]
    cases += [cache_case(name, Path(owned) / ('cache-' + name), storage, normalization, constants) for name in CACHES]
    source = [dict(path='scripts/job_apply_store/' + name + '.py',
                   sha256=digest((ROOT / 'scripts/job_apply_store' / (name + '.py')).read_bytes())) for name in MODULES]
    source += [dict(path=str(path.relative_to(ROOT)), sha256=digest(path.read_bytes()))
               for path in (HERE / 'reference.py', HERE / 'fixtures.py', HERE / 'support.py')]
    output = dict(schemaVersion=1, scope='owned-point-path-reference', sourceProvenance=source,
                  cases=cases, **provenance())
    print(json.dumps(output, ensure_ascii=True, separators=(',', ':')))
