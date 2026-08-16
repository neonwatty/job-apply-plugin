from __future__ import annotations

import errno
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import stat
from typing import Any


ALLOWED_SUFFIXES = {".json", ".html", ".css", ".js", ".txt"}

# Replay fixture candidates are small; these bounds cap work before content scanning.
MAX_ENTRIES = 2_000
MAX_DEPTH = 32
MAX_FILES = 1_000
MAX_FILE_BYTES = 1 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_DENIED_TERMS = 256
MAX_DENIED_TERM_CHARS = 512

_DESCRIPTOR_TRAVERSAL_AVAILABLE = (
    hasattr(os, "O_DIRECTORY")
    and hasattr(os, "O_NOFOLLOW")
    and os.open in getattr(os, "supports_dir_fd", set())
    and os.scandir in getattr(os, "supports_fd", set())
)

_PATTERNS = {
    "email": re.compile(
        rb"(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9._%+-])",
        re.IGNORECASE,
    ),
    "phone": re.compile(
        rb"(?<![A-Fa-f0-9])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})"
        rb"[ .-]?\d{3}[ .-]?\d{4}(?![A-Fa-f0-9])"
    ),
    "source-url": re.compile(
        rb"(?:linkedin\.com\b|ashbyhq\.com\b|lever\.co\b|/jobs?(?:[/#?]|\b))",
        re.IGNORECASE,
    ),
    "credential": re.compile(
        rb"(?<![A-Z0-9_-])(?:"
        rb'"(?:authorization|cookie|set-cookie)"|'
        rb"'(?:authorization|cookie|set-cookie)'|"
        rb"(?:authorization|cookie|set-cookie)"
        rb")\s*[:=]|\bbearer\s+[A-Z0-9._~+/=-]+|"
        rb"\bdocument\s*\.\s*cookie\b",
        re.IGNORECASE,
    ),
    "source-html": re.compile(
        rb"<script\s+[^>]*\bsrc\s*=|linkedin-logo|voyager-web|ashby-logo|lever-logo",
        re.IGNORECASE,
    ),
}

_CREDENTIAL_KEYS = {
    "authorization",
    "cookie",
    "cookies",
    "credential",
    "credentials",
    "set-cookie",
}
_HEADER_KEYS = {"header", "headers"}
_HEADER_CREDENTIAL_NAMES = {"authorization", "cookie", "set-cookie"}


class PrivacyError(ValueError):
    pass


@dataclass
class _ScanState:
    denied_terms: list[tuple[int, str]]
    findings: set[tuple[str, str]] = field(default_factory=set)
    entry_count: int = 0
    file_count: int = 0
    total_bytes: int = 0


def _escaped_relative_path(relative_path: str) -> str:
    return json.dumps(relative_path, ensure_ascii=True)


def _raise(findings: set[tuple[str, str]]) -> None:
    diagnostics = ", ".join(
        f"{category}:{_escaped_relative_path(relative_path)}"
        for category, relative_path in sorted(findings)
    )
    raise PrivacyError(f"privacy scan failed: {diagnostics}")


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _open_error_category(error: OSError) -> str:
    if error.errno in {errno.ELOOP, errno.ENOENT, errno.ENOTDIR, errno.EISDIR}:
        return "unsafe-entry"
    return "unreadable"


def _read_descriptor(descriptor: int, byte_limit: int) -> bytes:
    chunks = []
    bytes_read = 0
    while bytes_read <= byte_limit:
        chunk = os.read(descriptor, min(64 * 1024, byte_limit + 1 - bytes_read))
        if not chunk:
            break
        chunks.append(chunk)
        bytes_read += len(chunk)
    return b"".join(chunks)


def _json_has_credentials(value: Any) -> bool:
    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            for key, child in current.items():
                normalized_key = key.casefold() if isinstance(key, str) else ""
                if normalized_key in _CREDENTIAL_KEYS:
                    return True
                if (
                    normalized_key in _HEADER_KEYS
                    and _header_container_has_credentials(child)
                ):
                    return True
                pending.append(child)
        elif isinstance(current, list):
            if _header_pair_has_credentials(current):
                return True
            pending.extend(current)
    return False


def _header_pair_has_credentials(value: list[Any]) -> bool:
    return (
        len(value) >= 2
        and isinstance(value[0], str)
        and value[0].casefold() in _HEADER_CREDENTIAL_NAMES
    )


def _header_container_has_credentials(value: Any) -> bool:
    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            if any(
                isinstance(key, str)
                and key.casefold() in _HEADER_CREDENTIAL_NAMES
                for key in current
            ):
                return True
            pending.extend(current.values())
        elif isinstance(current, list):
            if _header_pair_has_credentials(current):
                return True
            pending.extend(current)
    return False


def _compiled_denied_terms(denied_terms: list[str]) -> list[tuple[int, str]]:
    if len(denied_terms) > MAX_DENIED_TERMS:
        _raise({("limit-denied-term-count", ".")})

    compiled = []
    for index, denied_term in enumerate(denied_terms):
        if not isinstance(denied_term, str):
            _raise({("invalid-denied-term", ".")})
        if len(denied_term) > MAX_DENIED_TERM_CHARS:
            _raise({("limit-denied-term-length", ".")})
        if denied_term:
            compiled.append((index, denied_term.casefold()))
    return compiled


def _scan_content(
    content: bytes,
    relative_text: str,
    denied_terms: list[tuple[int, str]],
    findings: set[tuple[str, str]],
) -> None:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        findings.add(("unexpected-file-type", relative_text))
        return
    if "\x00" in text:
        findings.add(("unexpected-file-type", relative_text))
        return

    for category, pattern in _PATTERNS.items():
        if pattern.search(content):
            findings.add((category, relative_text))

    try:
        json_value = json.loads(text)
    except (json.JSONDecodeError, RecursionError):
        pass
    else:
        if _json_has_credentials(json_value):
            findings.add(("credential", relative_text))

    casefolded_text = text.casefold()
    for index, denied_term in denied_terms:
        if denied_term in casefolded_text:
            findings.add((f"denied-term-{index}", relative_text))


def _scan_directory(
    directory_descriptor: int,
    relative_directory: Path,
    depth: int,
    directory_flags: int,
    state: _ScanState,
) -> bool:
    remaining_entries = MAX_ENTRIES - state.entry_count
    entries = []
    try:
        with os.scandir(directory_descriptor) as iterator:
            for entry in iterator:
                entries.append(entry)
                if len(entries) > remaining_entries:
                    state.findings = {("limit-entry-count", ".")}
                    return True
    except OSError:
        state.entry_count += len(entries)
        state.findings.add(("unreadable", relative_directory.as_posix() or "."))
        return False

    state.entry_count += len(entries)
    entries.sort(key=lambda entry: entry.name)

    for entry in entries:
        relative = relative_directory / entry.name
        relative_text = relative.as_posix()
        try:
            entry_identity = entry.stat(follow_symlinks=False)
        except OSError:
            state.findings.add(("unreadable", relative_text))
            continue

        if stat.S_ISLNK(entry_identity.st_mode):
            state.findings.add(("symlink", relative_text))
            continue
        if stat.S_ISDIR(entry_identity.st_mode):
            if depth >= MAX_DEPTH:
                state.findings.add(("limit-depth", relative_text))
                continue
            child_descriptor = None
            try:
                child_descriptor = os.open(
                    entry.name,
                    directory_flags,
                    dir_fd=directory_descriptor,
                )
                opened_identity = os.fstat(child_descriptor)
            except OSError as error:
                if child_descriptor is not None:
                    os.close(child_descriptor)
                state.findings.add((_open_error_category(error), relative_text))
                continue
            if not stat.S_ISDIR(opened_identity.st_mode) or not _same_identity(
                entry_identity, opened_identity
            ):
                os.close(child_descriptor)
                state.findings.add(("unsafe-entry", relative_text))
                continue
            try:
                if _scan_directory(
                    child_descriptor,
                    relative,
                    depth + 1,
                    directory_flags,
                    state,
                ):
                    return True
            finally:
                os.close(child_descriptor)
            continue

        if not stat.S_ISREG(entry_identity.st_mode):
            state.findings.add(("unexpected-file-type", relative_text))
            continue

        state.file_count += 1
        if state.file_count > MAX_FILES:
            state.findings.add(("limit-file-count", relative_text))
            continue
        if Path(entry.name).suffix not in ALLOWED_SUFFIXES:
            state.findings.add(("unexpected-suffix", relative_text))
            continue

        file_descriptor = None
        try:
            file_descriptor = os.open(
                entry.name,
                os.O_RDONLY | os.O_NOFOLLOW,
                dir_fd=directory_descriptor,
            )
            opened_identity = os.fstat(file_descriptor)
        except OSError as error:
            if file_descriptor is not None:
                os.close(file_descriptor)
            state.findings.add((_open_error_category(error), relative_text))
            continue
        try:
            if not stat.S_ISREG(opened_identity.st_mode) or not _same_identity(
                entry_identity, opened_identity
            ):
                state.findings.add(("unsafe-entry", relative_text))
                continue
            if opened_identity.st_size > MAX_FILE_BYTES:
                state.findings.add(("limit-file-bytes", relative_text))
                continue
            if state.total_bytes + opened_identity.st_size > MAX_TOTAL_BYTES:
                state.findings.add(("limit-total-bytes", relative_text))
                continue
            try:
                content = _read_descriptor(file_descriptor, MAX_FILE_BYTES)
            except OSError:
                state.findings.add(("unreadable", relative_text))
                continue
            if len(content) > MAX_FILE_BYTES:
                state.findings.add(("limit-file-bytes", relative_text))
                continue
            if state.total_bytes + len(content) > MAX_TOTAL_BYTES:
                state.findings.add(("limit-total-bytes", relative_text))
                continue
            state.total_bytes += len(content)
            _scan_content(
                content,
                relative_text,
                state.denied_terms,
                state.findings,
            )
        finally:
            os.close(file_descriptor)

    return False


def scan_tree(root: Path, denied_terms: list[str]) -> None:
    compiled_denied_terms = _compiled_denied_terms(denied_terms)
    root = Path(root)

    try:
        root_identity = root.lstat()
    except OSError:
        _raise({("root", ".")})
    if stat.S_ISLNK(root_identity.st_mode):
        _raise({("symlink", ".")})
    if not stat.S_ISDIR(root_identity.st_mode):
        _raise({("root", ".")})
    if not _DESCRIPTOR_TRAVERSAL_AVAILABLE:
        _raise({("unsupported-platform", ".")})

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_descriptor = None
    try:
        root_descriptor = os.open(root, directory_flags)
        opened_root_identity = os.fstat(root_descriptor)
    except OSError:
        if root_descriptor is not None:
            os.close(root_descriptor)
        _raise({("root", ".")})
    if not stat.S_ISDIR(opened_root_identity.st_mode) or not _same_identity(
        root_identity, opened_root_identity
    ):
        os.close(root_descriptor)
        _raise({("unsafe-entry", ".")})

    state = _ScanState(compiled_denied_terms)
    try:
        _scan_directory(root_descriptor, Path(), 0, directory_flags, state)
    finally:
        os.close(root_descriptor)

    if state.findings:
        _raise(state.findings)
