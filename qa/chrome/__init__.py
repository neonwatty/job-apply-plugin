"""Public API for dedicated replay-QA Chrome profiles."""

from qa.chrome.cli import main
from qa.chrome.commands import (
    command_check as check,
    command_reset as reset,
    command_start as start,
    command_stop as stop,
)
from qa.chrome.control import ControlHandler, ControlServer
from qa.chrome.discovery import discover_chrome
from qa.chrome.paths import Ambiguous, BoundPaths, UserError, validate_profile


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
