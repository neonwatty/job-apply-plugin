from __future__ import annotations

import os
from pathlib import Path
import re
import stat


ALLOWED_SUFFIXES = {".json", ".html", ".css", ".js", ".txt"}

_PATTERNS = {
    "email": re.compile(
        rb"(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9._%+-])",
        re.IGNORECASE,
    ),
    "phone": re.compile(
        rb"(?<!\d)(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?\d{3}[ .-]?\d{4}(?!\d)"
    ),
    "source-url": re.compile(
        rb"(?:linkedin\.com\b|/jobs?(?:[/#?]|\b))",
        re.IGNORECASE,
    ),
    "credential": re.compile(
        rb"\b(?:authorization|cookie|set-cookie)\s*:|\bbearer\s+[A-Z0-9._~+/=-]+",
        re.IGNORECASE,
    ),
    "source-html": re.compile(
        rb"<script\s+[^>]*\bsrc\s*=|linkedin-logo|voyager-web",
        re.IGNORECASE,
    ),
}


class PrivacyError(ValueError):
    pass


def _raise(findings: set[tuple[str, str]]) -> None:
    diagnostics = ", ".join(
        f"{category}:{relative_path}"
        for category, relative_path in sorted(findings)
    )
    raise PrivacyError(f"privacy scan failed: {diagnostics}")


def _read_regular_file(candidate: Path) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(candidate, flags)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("not a regular file")
        chunks = []
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
    finally:
        os.close(descriptor)


def scan_tree(root: Path, denied_terms: list[str]) -> None:
    root = Path(root)
    try:
        if root.is_symlink():
            _raise({("symlink", ".")})
        root_resolved = root.resolve(strict=True)
        if not root_resolved.is_dir():
            _raise({("root", ".")})
    except PrivacyError:
        raise
    except (OSError, RuntimeError):
        _raise({("root", ".")})

    findings: set[tuple[str, str]] = set()
    pending = [(root_resolved, Path())]

    while pending:
        directory, relative_directory = pending.pop()
        try:
            with os.scandir(directory) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name)
        except OSError:
            findings.add(("unreadable", relative_directory.as_posix() or "."))
            continue

        for entry in entries:
            relative = relative_directory / entry.name
            relative_text = relative.as_posix()
            candidate = Path(entry.path)
            try:
                if entry.is_symlink():
                    findings.add(("symlink", relative_text))
                    continue
                mode = entry.stat(follow_symlinks=False).st_mode
            except OSError:
                findings.add(("unreadable", relative_text))
                continue

            if stat.S_ISDIR(mode):
                try:
                    resolved = candidate.resolve(strict=True)
                    resolved.relative_to(root_resolved)
                except (OSError, RuntimeError, ValueError):
                    findings.add(("outside-root", relative_text))
                    continue
                pending.append((resolved, relative))
                continue

            if not stat.S_ISREG(mode):
                findings.add(("unexpected-file-type", relative_text))
                continue
            if candidate.suffix not in ALLOWED_SUFFIXES:
                findings.add(("unexpected-suffix", relative_text))
                continue

            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(root_resolved)
            except (OSError, RuntimeError, ValueError):
                findings.add(("outside-root", relative_text))
                continue

            try:
                content = _read_regular_file(resolved)
            except ValueError:
                findings.add(("unexpected-file-type", relative_text))
                continue
            except OSError:
                findings.add(("unreadable", relative_text))
                continue

            try:
                content.decode("utf-8")
            except UnicodeDecodeError:
                findings.add(("unexpected-file-type", relative_text))
                continue
            if b"\x00" in content:
                findings.add(("unexpected-file-type", relative_text))
                continue

            for category, pattern in _PATTERNS.items():
                if pattern.search(content):
                    findings.add((category, relative_text))
            lowered = content.lower()
            for index, denied_term in enumerate(denied_terms):
                if isinstance(denied_term, str) and denied_term:
                    if denied_term.encode("utf-8").lower() in lowered:
                        findings.add((f"denied-term-{index}", relative_text))

    if findings:
        _raise(findings)
