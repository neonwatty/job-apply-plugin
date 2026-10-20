"""Stable compatibility facade for recorder filesystem operations."""

from __future__ import annotations

import errno

from qa.recorder_broker import SessionBroker
from qa.recorder_fs_ops import (
    MAX_DEPTH,
    MAX_ENTRIES,
    MAX_FILE_BYTES,
    MAX_PATH_BYTES,
    MAX_REQUEST_BYTES,
    MAX_SEGMENT_BYTES,
    MAX_SESSION_BYTES,
    _CHECKPOINT,
    _CHECKPOINT_FILES,
    _DIRECTORY_FLAGS,
    _EXCLUSIVE_RENAME,
    _FILE_READ_FLAGS,
    _FILE_WRITE_FLAGS,
    _SEGMENT,
    BrokerError,
    _direct_name,
    _exclusive_rename_raw as _exclusive_rename_raw_leaf,
    _load_exclusive_rename,
    _parts,
    _write_all,
    exclusive_rename_available,
)
from qa.recorder_guardian import (
    _COMMAND_KEYS,
    _bounded_lines,
    _cleanup_guardian,
    _decode_data,
    _dispatch,
    _serve,
    _start_cleanup_guardian,
    main,
)


def _exclusive_rename_raw(
    src_dir_fd: int,
    src_name: bytes,
    dst_dir_fd: int,
    dst_name: bytes,
) -> int:
    return _exclusive_rename_raw_leaf(
        src_dir_fd, src_name, dst_dir_fd, dst_name
    )


def exclusive_rename(
    src_dir_fd: int,
    src_name: str,
    dst_dir_fd: int,
    dst_name: str,
) -> None:
    source = _direct_name(src_name)
    destination = _direct_name(dst_name)
    result = _exclusive_rename_raw(src_dir_fd, source, dst_dir_fd, destination)
    if result == 0:
        return
    if result == errno.EEXIST:
        raise BrokerError("destination-exists")
    if result == errno.ENOSYS:
        raise BrokerError("exclusive-rename-unsupported")
    raise BrokerError("rename-failed")


if __name__ == "__main__":
    raise SystemExit(main())
