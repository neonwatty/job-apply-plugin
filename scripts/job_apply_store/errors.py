"""Value-free Store exception types."""


class StoreError(Exception):
    """An expected, safe-to-display storage failure."""


class TrustedFillCurrentError(StoreError):
    """A value-free canonical-state denial that requires claim handoff."""

    def __init__(self, reason_code: str):
        super().__init__("trusted fill canonical state is unavailable")
        self.reason_code = reason_code
