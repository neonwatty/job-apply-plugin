"""Frozen CLI receipt entries for application automation authority."""


def receipts(command, option):
    return [
        command("application-authority-set", [
            option("input", required=True),
            option("expected-revision", required=True, integer=True),
        ]),
        command("application-authority-status", []),
        command("application-authority-evaluate", [option("input", required=True)]),
        command("application-authority-revoke", [
            option("expected-revision", required=True, integer=True),
        ]),
    ]


def trusted_fill_receipts(command, option):
    return [
        command("trusted-fill-approve", [option("input", required=True)]),
        command("trusted-fill-status", [option("id", required=True)]),
        command("trusted-fill-evaluate", [option("input", required=True)]),
        command("trusted-fill-revoke", [
            option("id", required=True),
            option("expected-approval-revision", required=True, integer=True),
        ]),
    ]
