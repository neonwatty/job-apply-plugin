"""Fixed original-method domain observation; no caller paths or live Store."""
import sys
if len(sys.argv) != 1 or sys.stdin.buffer.read(1):
    sys.stderr.write('point_paths_domain_reference_input_rejected\n')
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
from fixtures import recipes
from support import Pool, digest, observe
PINS = {'scripts/job_apply_store/__init__.py': 'd1f3908a9875fdeda94a2d1823b0e42edb29c7814a638b8edcdc15e127052a04',
 'scripts/job_apply_store/base.py': 'e1deee9f49d012eac54f3ef4990c7641d43874afa699c8d12d79919599f27c88',
 'scripts/job_apply_store/constants.py': '4438a36055842e18af0ae806fed1f61bf8280908995f7295662a4213226e8b5c',
 'scripts/job_apply_store/domains/__init__.py': 'b112b206edd338aa0dd2a17d1414be2c843d6d44337249d59079a82129cd0c26',
 'scripts/job_apply_store/domains/coordinator/__init__.py': '8515203ac4bc80d5d722deffa1879e08518b2a200a7bdbab5425c8dee43ee1be',
 'scripts/job_apply_store/domains/coordinator/persistence.py': '1296863bad9412b852879a3b9c653a98ca61375811df2690600e6f69bc7c3177',
 'scripts/job_apply_store/domains/resumes/__init__.py': '9ff7cd33ef9e3c17454ac38ab147f3eaec75e44816a6ea8fa0a5d3fa381dfba0',
 'scripts/job_apply_store/domains/resumes/storage.py': '97ec178e0b3ddc1d3be97b1c6c34983ecf9c50caa9c6f4fd4125dbb71c6db6fe',
 'scripts/job_apply_store/errors.py': 'be48cff00389f30d0f51f95ec154baec6162a57350b2ab3cfcb531da7456e01c',
 'scripts/job_apply_store/io.py': '6e4b36c224fdf34924f14fecbd6d8afaf398afcff455509b85a817008c407d53',
 'scripts/job_apply_store/normalization.py': '8c299675838779908a1d3876db22fc2d9b32a2e08a890246357193b1d20b2beb',
 'scripts/job_apply_store/validation/__init__.py': 'b8e8d8f492cf48c33321d01db8899357f333cf94b93e5f20835cce62104524e3',
 'scripts/job_apply_store/validation/accounts.py': 'aa62b41eabe54f13c3b3fbb9791dedafc98dbac9d4e68262452e69bfb2457ddc',
 'scripts/job_apply_store/validation/extraction.py': '6437704da0aefe5b3351c129a5b3e36e49da4db9a8d56c60ba19d28825b5d7d8',
 'scripts/job_apply_store/validation/jobs_resumes.py': '1ad4bffefc7cc6a605d2fa04b0d2e1ccb5804091064083787f4126c157274c83',
 'scripts/job_apply_store/validation/profile_answers.py': '599715a998b68fb0ac1ab67c0930564fda9fb69206084c12dafccfb83c9e65d9',
 'scripts/job_apply_store/validation/sessions.py': '9d1c6158facc0724e5500defbc8027931e2112927677d9f3b79d5a8fde5339ce'}
for name, expected in PINS.items():
    if digest((ROOT / name).read_bytes()) != expected:
        raise RuntimeError('original source pin mismatch: ' + name)
sys.path.insert(0, str(ROOT / 'scripts'))
from job_apply_store import constants, normalization
from job_apply_store.domains.resumes import storage
if sys.platform != 'darwin':
    raise SystemExit('point_paths_domain_reference_requires_darwin')


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
        elif origin in ('built-in', 'frozen'):
            loaded.append(dict(name=name, origin=origin))
    executable = Path(sys.executable).resolve()
    return dict(profile=dict(version=sys.version, versionInfo=list(sys.version_info[:3]),
        implementation=platform.python_implementation(), platform=sys.platform,
        machine=platform.machine(), byteorder=sys.byteorder, executable=str(executable),
        executableSha256=digest(executable.read_bytes()), filesystemEncoding=sys.getfilesystemencoding(),
        filesystemErrors=sys.getfilesystemencodeerrors(), isolated=sys.flags.isolated), loadedModules=loaded)


with tempfile.TemporaryDirectory(prefix='s05-domain-') as temporary:
    pool = Pool()
    rows = [observe(recipe, Path(temporary) / recipe['id'], storage, normalization, constants, pool)
            for recipe in recipes()]
    sources = [dict(path=name, sha256=expected) for name, expected in PINS.items()]
    sources += [dict(path=str(path.relative_to(ROOT)), sha256=digest(path.read_bytes()))
                for path in (HERE / 'reference.py', HERE / 'fixtures.py', HERE / 'support.py')]
    print(json.dumps(dict(schemaVersion=1, rows=rows, observations=pool.rows,
                         localSources=sources, **provenance()), ensure_ascii=True, separators=(',', ':')))
