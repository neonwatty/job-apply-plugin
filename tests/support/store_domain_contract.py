"""Reusable composition and architecture contracts for Store domain leaves."""

from __future__ import annotations

import ast
import inspect
import shutil
import stat
from pathlib import Path
from typing import Any


DOMAIN_PACKAGE = "job_apply_store.domains"

__all__ = [
    "assert_domain_import_direction",
    "assert_method_contract",
    "assert_store_trees_equal",
    "clone_store_root",
    "composed_store_class",
    "snapshot_tree",
    "source_inventory",
]


def composed_store_class(base_store: type, *domain_mixins: type) -> type:
    """Build a deterministic test Store with domain mixins before its facade."""
    if not isinstance(base_store, type):
        raise TypeError("base_store must be a class")
    if not domain_mixins:
        raise ValueError("at least one domain mixin is required")
    if any(not isinstance(mixin, type) for mixin in domain_mixins):
        raise TypeError("domain mixins must be classes")
    if len(set(domain_mixins)) != len(domain_mixins) or base_store in domain_mixins:
        raise ValueError("composition classes must be unique")
    name = "_".join([*(item.__name__ for item in domain_mixins), base_store.__name__])
    return type(f"{name}Composition", (*domain_mixins, base_store), {})


def _method_function(owner: type, name: str) -> Any:
    value = inspect.getattr_static(owner, name)
    if isinstance(value, (classmethod, staticmethod)):
        return value.__func__
    return value


def assert_method_contract(
    testcase: Any,
    base_cls: type,
    mixin_cls: type,
    names: list[str] | tuple[str, ...] | set[str],
) -> None:
    """Compare method metadata that extraction must preserve exactly."""
    for name in names:
        message = f"method contract drift: {name}"
        testcase.assertIn(name, vars(mixin_cls), f"{message}; mixin does not own method")
        base_method = _method_function(base_cls, name)
        mixin_method = _method_function(mixin_cls, name)
        testcase.assertEqual(mixin_method.__name__, base_method.__name__, message)
        testcase.assertEqual(
            mixin_method.__qualname__.rsplit(".", 1)[-1],
            base_method.__qualname__.rsplit(".", 1)[-1],
            message,
        )
        testcase.assertEqual(
            str(inspect.signature(getattr(mixin_cls, name))),
            str(inspect.signature(getattr(base_cls, name))),
            message,
        )
        testcase.assertEqual(mixin_method.__doc__, base_method.__doc__, message)
        testcase.assertEqual(
            mixin_method.__annotations__, base_method.__annotations__, message
        )


def source_inventory(domain_root: Path) -> dict[str, dict[str, tuple[str, ...]]]:
    """Return module -> class -> directly defined method names in source order."""
    inventory: dict[str, dict[str, tuple[str, ...]]] = {}
    for path in sorted(domain_root.rglob("*.py")):
        if path.is_symlink():
            raise AssertionError(f"domain source must not be a symlink: {path}")
        relative = path.relative_to(domain_root).with_suffix("")
        module = ".".join(relative.parts)
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        classes: dict[str, tuple[str, ...]] = {}
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            classes[node.name] = tuple(
                child.name
                for child in node.body
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            )
        inventory[module] = classes
    return inventory


def snapshot_tree(root: Path) -> dict[str, tuple[bytes, int]]:
    """Capture relative regular-file bytes and permission modes without links."""
    if root.is_symlink():
        raise AssertionError(f"Store root must not be a symlink: {root}")
    if not root.is_dir():
        raise AssertionError(f"Store root is not a directory: {root}")
    snapshot: dict[str, tuple[bytes, int]] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise AssertionError(f"Store tree contains a symlink: {relative}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise AssertionError(f"Store tree contains a non-regular file: {relative}")
        snapshot[relative] = (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
    return snapshot


def clone_store_root(source: Path, destination: Path) -> Path:
    """Copy a validated Store root and prove that bytes and modes are unchanged."""
    expected = snapshot_tree(source)
    if destination.exists() or destination.is_symlink():
        raise AssertionError(f"clone destination already exists: {destination}")
    shutil.copytree(source, destination, copy_function=shutil.copy2)
    actual = snapshot_tree(destination)
    if actual != expected:
        raise AssertionError("cloned Store tree differs from its source")
    return destination


def assert_store_trees_equal(testcase: Any, left: Path, right: Path) -> None:
    """Assert exact regular-file bytes and modes for two isolated Store roots."""
    testcase.assertEqual(snapshot_tree(left), snapshot_tree(right))


def _source_module(path: Path, root: Path) -> tuple[str, bool]:
    relative = path.relative_to(root).with_suffix("")
    parts = list(relative.parts)
    is_package = parts[-1] == "__init__"
    if is_package:
        parts.pop()
    suffix = ".".join(parts)
    return (f"{DOMAIN_PACKAGE}.{suffix}".rstrip("."), is_package)


def _import_targets(node: ast.Import | ast.ImportFrom, module: str, is_package: bool) -> list[str]:
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    if node.level == 0:
        return [node.module or ""]
    package = module.split(".") if is_package else module.split(".")[:-1]
    remove = node.level - 1
    if remove > len(package):
        return ["<invalid-relative-import>"]
    base = package[: len(package) - remove]
    target = ".".join([*base, *((node.module or "").split("."))]).rstrip(".")
    if node.module:
        return [target]
    return [f"{target}.{alias.name}" for alias in node.names]


def _cycle(edges: dict[str, set[str]]) -> list[str] | None:
    visiting: list[str] = []
    visited: set[str] = set()

    def visit(module: str) -> list[str] | None:
        if module in visiting:
            start = visiting.index(module)
            return [*visiting[start:], module]
        if module in visited:
            return None
        visiting.append(module)
        for target in sorted(edges[module]):
            found = visit(target)
            if found:
                return found
        visiting.pop()
        visited.add(module)
        return None

    for module in sorted(edges):
        found = visit(module)
        if found:
            return found
    return None


def assert_domain_import_direction(testcase: Any, domain_root: Path) -> None:
    """Reject facade/domain imports from leaves and all domain dependency cycles."""
    sources = sorted(domain_root.rglob("*.py"))
    modules = {_source_module(path, domain_root)[0]: path for path in sources}
    edges = {module: set() for module in modules}
    problems: list[str] = []
    for module, path in modules.items():
        if path.is_symlink():
            problems.append(f"{module}: source is a symlink")
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        is_package = path.name == "__init__.py"
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Import, ast.ImportFrom)):
                continue
            for target in _import_targets(node, module, is_package):
                is_domain = target == DOMAIN_PACKAGE or target.startswith(DOMAIN_PACKAGE + ".")
                is_facade = (
                    "job-apply-store" in target
                    or target.endswith("job_apply_store_facade")
                    or target.startswith("_job_apply_store_parts_")
                )
                if is_domain:
                    problems.append(f"{module}: domain import {target}")
                    if target in modules:
                        edges[module].add(target)
                if is_facade:
                    problems.append(f"{module}: facade import {target}")
    cycle = _cycle(edges)
    if cycle:
        problems.append("domain dependency cycle: " + " -> ".join(cycle))
    testcase.assertFalse(problems, "\n".join(problems))
