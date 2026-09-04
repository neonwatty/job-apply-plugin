from __future__ import annotations

import re
import shlex
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TYPECHECK_PREFIX = ("xcrun", "swiftc", "-typecheck")


def workflow_typecheck_sources(
    workflow: str | None = None,
) -> dict[tuple[str, str], tuple[str, ...]]:
    if workflow is None:
        workflow = (ROOT / ".github/workflows/validate.yml").read_text(encoding="utf-8")
    sources: dict[tuple[str, str], tuple[str, ...]] = {}
    current_job: str | None = None
    current_step: str | None = None
    in_jobs = False

    def record(command: str) -> None:
        try:
            arguments = shlex.split(command, comments=True, posix=True)
        except ValueError:
            return
        swift_paths = arguments[len(TYPECHECK_PREFIX):]
        if tuple(arguments[:len(TYPECHECK_PREFIX)]) != TYPECHECK_PREFIX or not swift_paths:
            return
        if any(
            path != f"native/macos/{Path(path).name}" or not path.endswith(".swift")
            for path in swift_paths
        ):
            return
        if current_job is None or current_step is None:
            raise AssertionError("typecheck command is not bound to a workflow job and step")
        key = (current_job, current_step)
        if key in sources:
            raise AssertionError("workflow job and step contains duplicate typecheck commands")
        sources[key] = tuple(Path(path).name for path in swift_paths)

    def record_block(block: list[str], indicator: str) -> None:
        indents = [len(line) - len(line.lstrip()) for line in block if line.strip()]
        if not indents:
            return
        indent = min(indents)
        scalar = [line[indent:] if line.strip() else "" for line in block]
        rendered = ""
        previous: str | None = None
        for line in scalar:
            if previous is not None:
                fold = (
                    indicator.startswith(">") and previous and line
                    and not previous[0].isspace() and not line[0].isspace()
                )
                rendered += " " if fold else "\n"
            rendered += line
            previous = line
        pending = ""
        for line in rendered.splitlines() + [""]:
            part = line.strip()
            if not part:
                if pending:
                    record(pending)
                    pending = ""
                continue
            pending += part
            if pending.endswith("\\"):
                pending = pending[:-1].rstrip() + " "
            else:
                record(pending)
                pending = ""

    lines = workflow.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if line == "jobs:":
            in_jobs = True
            index += 1
            continue
        if not in_jobs:
            index += 1
            continue
        job = re.fullmatch(r"  ([a-z0-9][a-z0-9-]*):", line)
        if job:
            current_job, current_step = job.group(1), None
            index += 1
            continue
        step = re.fullmatch(r"      -(?: name: (.+)|.*)", line)
        if step:
            current_step = step.group(1)
            index += 1
            continue
        run = re.fullmatch(r"        run:(?:[ \t]+(.*))?", line)
        if not run:
            index += 1
            continue
        value = (run.group(1) or "").strip()
        if not re.fullmatch(r"[|>][-+]?", value):
            record(value)
            index += 1
            continue
        index += 1
        block: list[str] = []
        while index < len(lines):
            block_line = lines[index]
            if block_line.strip() and len(block_line) - len(block_line.lstrip()) <= 8:
                break
            block.append(block_line)
            index += 1
        record_block(block, value)
    return sources


def workflow_typecheck_command(sources: tuple[str, ...]) -> str:
    paths = " ".join(f"native/macos/{source}" for source in sources)
    return f"xcrun swiftc -typecheck {paths}"
