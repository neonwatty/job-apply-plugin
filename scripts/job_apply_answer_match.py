#!/usr/bin/env python3
"""Deterministic, value-free answer matching compatibility facade."""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path


_PACKAGE_NAME = "_job_apply_answer_matching_parts"
if _PACKAGE_NAME not in sys.modules:
    _package = types.ModuleType(_PACKAGE_NAME)
    _package.__path__ = [str(Path(__file__).with_name("job_apply_answer_matching"))]
    _package.__package__ = _PACKAGE_NAME
    sys.modules[_PACKAGE_NAME] = _package

_features = importlib.import_module(f"{_PACKAGE_NAME}.features")
_scoring = importlib.import_module(f"{_PACKAGE_NAME}.scoring")
_reuse = importlib.import_module(f"{_PACKAGE_NAME}.reuse")
_cleanup = importlib.import_module(f"{_PACKAGE_NAME}.cleanup")

for _source in (_features, _scoring, _reuse, _cleanup):
    for _name in dir(_source):
        if not _name.startswith("__"):
            globals().setdefault(_name, getattr(_source, _name))


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
