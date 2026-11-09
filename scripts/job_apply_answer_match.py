#!/usr/bin/env python3
"""Deterministic, value-free answer matching compatibility facade."""

from __future__ import annotations

import importlib
import hashlib as _hashlib
import sys
import types
from pathlib import Path


_IMPLEMENTATION_ROOT = Path(__file__).with_name("job_apply_answer_matching").resolve()
_PACKAGE_NAME = "_job_apply_answer_matching_parts_" + _hashlib.sha256(
    str(_IMPLEMENTATION_ROOT).encode("utf-8")
).hexdigest()
for _module_name in tuple(sys.modules):
    if _module_name == _PACKAGE_NAME or _module_name.startswith(_PACKAGE_NAME + "."):
        del sys.modules[_module_name]
_package = types.ModuleType(_PACKAGE_NAME)
_package.__path__ = [str(_IMPLEMENTATION_ROOT)]
_package.__package__ = _PACKAGE_NAME
sys.modules[_PACKAGE_NAME] = _package

_features = importlib.import_module(f"{_PACKAGE_NAME}.features")
_scoring = importlib.import_module(f"{_PACKAGE_NAME}.scoring")
_reuse = importlib.import_module(f"{_PACKAGE_NAME}.reuse")
_cleanup = importlib.import_module(f"{_PACKAGE_NAME}.cleanup")

for _source in (_features, _scoring, _reuse, _cleanup):
    for _name in dir(_source):
        if not _name.startswith("__"):
            globals()[_name] = getattr(_source, _name)


def propose_cleanup(*, candidates):
    return _cleanup.propose_cleanup(candidates=candidates, _ranker=rank_candidates)


__all__ = [
    "AnswerMatchError",
    "AUTHORITY_ACCEPTED_RECORD",
    "AUTHORITY_BOUNDED_POLICY",
    "AUTHORITY_NONE",
    "AUTHORITY_PER_USE",
    "CONFIDENCE_BANDS",
    "MODE_BOUNDED_LOOSE",
    "MODE_STRICT",
    "REASON_CODES",
    "evaluate_reuse",
    "propose_cleanup",
    "rank_candidates",
]
