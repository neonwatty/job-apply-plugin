"""Public API for fail-closed fixture promotion."""

from qa.promotion.approval import approve_candidate
from qa.promotion.bindings import PromotionError
from qa.promotion.candidate import compile_candidate
from qa.promotion.cli import main
from qa.promotion.transaction import promote_candidate


__all__ = [
    "PromotionError",
    "approve_candidate",
    "compile_candidate",
    "main",
    "promote_candidate",
]
