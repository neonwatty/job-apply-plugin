"""Control real staged-file observations in paired resume fixtures."""

import os
from contextlib import contextmanager
from unittest import mock


@contextmanager
def fixed_staged_resume_mtime(facade, stores, mtime_ns=1_725_451_200_000_000_000):
    """Set actual private temp mtime, then run the unmodified validator."""
    validator = facade._validate_resume_bytes
    private_directories = {store.resume_files_path for store in stores}

    def validate(path, extension):
        if (
            path.parent not in private_directories
            or path.suffix != ".tmp"
            or path.is_symlink()
        ):
            raise AssertionError("paired resume clock received an unexpected path")
        # These are private, test-owned regular files. Avoid optional no-follow
        # support that varies between Windows Python versions.
        os.utime(path, ns=(mtime_ns, mtime_ns))
        return validator(path, extension)

    with mock.patch.object(facade, "_validate_resume_bytes", side_effect=validate):
        yield
