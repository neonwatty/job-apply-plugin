"""Expected CLI receipts for shared-credential Store operations."""


def receipts(command, option):
    outcomes = (
        "ambiguous", "captcha_required", "email_verification_required",
        "failed_definitive", "mfa_required", "password_reset_required", "updated",
    )
    return [
        command("employer-account-shared-bind", [
            option("realm-ref", required=True),
            option("credential-version", required=True, integer=True),
            option("expected-revision", required=True, integer=True),
            option("owner-confirmed", boolean=True),
        ]),
        command("employer-account-shared-upgrade-begin", [
            option("realm-ref", required=True),
            option("target-version", required=True, integer=True),
            option("expected-revision", required=True, integer=True),
            option("owner-confirmed", boolean=True),
        ]),
        command("employer-account-shared-upgrade-complete", [
            option("operation-id", required=True),
            option("outcome", required=True, choices=outcomes),
            option("owner-confirmed", boolean=True),
        ]),
    ]
