"""Interpreter-neutral AST serialization for immutable source contracts."""

from __future__ import annotations

import ast
import copy
import hashlib
import inspect


def canonical_ast_dump(
    node: ast.AST, *, include_attributes: bool = False,
) -> str:
    """Match pre-3.12 dumps while retaining non-empty language metadata."""

    normalized = copy.deepcopy(node)
    for descendant in ast.walk(normalized):
        if getattr(descendant, "type_params", None) == []:
            delattr(descendant, "type_params")
    options = {"include_attributes": include_attributes}
    if "show_empty" in inspect.signature(ast.dump).parameters:
        options["show_empty"] = True
    return ast.dump(normalized, **options)


def canonical_ast_digest(
    node: ast.AST, *, include_attributes: bool = False,
) -> str:
    """Hash the canonical dump without interpreter-schema-only drift."""

    serialized = canonical_ast_dump(
        node, include_attributes=include_attributes
    )
    return hashlib.sha256(serialized.encode()).hexdigest()


__all__ = ["canonical_ast_digest", "canonical_ast_dump"]
