"""Public API for dedicated replay-QA Chrome profiles."""

from .cli import main
from .commands import (
    command_check as check,
    command_reset as reset,
    command_start as start,
    command_stop as stop,
)
from .control import ControlHandler, ControlServer
from .discovery import discover_chrome
from .paths import Ambiguous, BoundPaths, UserError, validate_profile


__all__ = [
    "Ambiguous",
    "BoundPaths",
    "ControlHandler",
    "ControlServer",
    "UserError",
    "check",
    "discover_chrome",
    "main",
    "reset",
    "start",
    "stop",
    "validate_profile",
]
