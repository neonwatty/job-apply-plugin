#!/usr/bin/env python3
"""Reject actionable final-action instructions that lack a safety boundary."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


SAFETY_CONTEXT = re.compile(
    r"\b(?:never|do not|don't|cannot|can't|must not|may not|should not|"
    r"blocked|disabled|forbidden|review[_ -]only|manual(?:ly)?|untouched|"
    r"stop(?:s|ped|ping)?\s+(?:at|before)|leave(?:s|ing)?\s+[^.]*\buntouched)\b",
    re.IGNORECASE,
)
LEADING_FINAL_ACTION = re.compile(
    r"^\s*(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))?(?:\*{1,2})?"
    r"(?:submit|send)\b",
    re.IGNORECASE,
)
CLICK_FINAL_CONTROL = re.compile(
    r"\b(?:click|activate)(?:s|ed|ing)?\b[^.!?\n]{0,80}"
    r"\b(?:submit|send|apply|final[ -]action)(?:\s+(?:button|control|action))?\b",
    re.IGNORECASE,
)
DIRECT_FINAL_ACTION = re.compile(
    r"\b(?:submit|send)(?:s|ted|ting)?\b[^.!?\n]{0,50}\b(?:application|form)\b|"
    r"\bappl(?:y|ies|ied|ying)\b[^.!?\n]{0,50}\b(?:now|automatically)\b",
    re.IGNORECASE,
)
EASY_APPLY_ENTRY_LABEL = re.compile(
    r"(?:(?P<quote>['\"`])Easy Apply(?P=quote)|Easy Apply)"
    r"(?=\s+(?:button|link)\b[^.!?\n]{0,80}"
    r"\b(?:to\s+open|for\s+opening)\s+(?:the\s+)?"
    r"(?:(?:application\s+)?modal|application\s+form)\b)",
    re.IGNORECASE,
)


def _is_actionable(text: str) -> bool:
    """Return whether a Markdown line positively directs a final action."""
    candidate = re.sub(r"^\s{0,3}#{1,6}\s+", "", text)
    final_control_candidate = EASY_APPLY_ENTRY_LABEL.sub(
        "application-entry",
        candidate,
    )
    return bool(
        LEADING_FINAL_ACTION.search(candidate)
        or CLICK_FINAL_CONTROL.search(final_control_candidate)
        or DIRECT_FINAL_ACTION.search(candidate)
    )


def violations_for_text(text: str) -> list[tuple[int, str]]:
    violations: list[tuple[int, str]] = []
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or not _is_actionable(stripped):
            continue
        if SAFETY_CONTEXT.search(stripped):
            continue
        violations.append((number, stripped))
    return violations


def check_path(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        return [f"unable to read final-action documentation {path}: {error}"]
    return [
        f"unsafe final-action instruction at {path}:{number}: {line}"
        for number, line in violations_for_text(text)
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    arguments = parser.parse_args(argv)
    errors = [error for path in arguments.paths for error in check_path(path)]
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
