"""Read a skill's reachable local references for contract and packaging checks.

Runtime agents still load references conditionally. This reader is for validation,
not an instruction to concatenate every reference during ordinary skill use.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit


def skill_documents(entry: Path) -> dict[Path, str]:
    entry = entry.resolve(strict=True)
    skill_root = entry.parent
    skills_root = skill_root.parent
    documents: dict[Path, str] = {}

    def visit(path: Path) -> None:
        if path in documents:
            return
        text = path.read_text(encoding="utf-8")
        documents[path] = text
        prose = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
        for target in re.findall(r"\]\((<[^>]+>|[^\s)]+)(?:\s+\"[^\"]*\")?\)", prose):
            parsed = urlsplit(target.strip("<>"))
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            destination = (path.parent / unquote(parsed.path)).resolve(strict=True)
            if not destination.is_relative_to(skills_root):
                raise ValueError(f"skill reference escapes skills directory: {path}: {target}")
            if not destination.is_file():
                raise ValueError(f"skill reference is not a file: {path}: {target}")
            if destination.is_relative_to(skill_root) and destination.suffix == ".md":
                visit(destination)

    visit(entry)
    references = skill_root / "references"
    if references.exists():
        unlinked = {p.resolve() for p in references.rglob("*.md")} - set(documents)
        if unlinked:
            raise ValueError(f"unreachable skill references: {sorted(str(p) for p in unlinked)}")
    return documents


def skill_text(entry: Path) -> str:
    return "\n\n".join(skill_documents(entry).values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("entry", type=Path)
    arguments = parser.parse_args()
    print(skill_text(arguments.entry))
