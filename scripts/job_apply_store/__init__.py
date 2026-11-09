"""Common Store foundations independent of the executable facade."""

from __future__ import annotations

from . import base, constants, domains, errors, io, normalization, validation
from .errors import StoreError, TrustedFillCurrentError
from .io import atomic_write_json, exclusive_file_lock, read_json_object, validate_version
from .normalization import (
    answer_key,
    normalize_job_url,
    normalize_question,
    normalize_resume_path,
    observe_resume_file,
)
from .validation import (
    accounts,
    extraction,
    jobs_resumes,
    profile_answers,
    sessions,
)
from .validation.extraction import order_extraction_requests


__all__ = [
    "StoreError",
    "TrustedFillCurrentError",
    "answer_key",
    "atomic_write_json",
    "domains",
    "errors",
    "exclusive_file_lock",
    "normalize_job_url",
    "normalize_question",
    "normalize_resume_path",
    "observe_resume_file",
    "order_extraction_requests",
    "read_json_object",
    "validate_version",
]
