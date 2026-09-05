from __future__ import annotations

import json
import subprocess
import sys
import unittest

from tests.support.store_facade_contract import (
    SCRIPT,
    dispatch_commands,
    load_module,
    parser_receipt,
)


def o(
    flag, *, required=False, integer=False, choices=None, default=None,
    boolean=False, append=False, help_text=None,
):
    kind = "_StoreTrueAction" if boolean else "_AppendAction" if append else "_StoreAction"
    return {
        "options": [f"--{flag}"],
        "dest": flag.replace("-", "_"),
        "kind": kind,
        "type": "int" if integer else None,
        "choices": list(choices) if choices is not None else None,
        "default": False if boolean else default,
        "required": required,
        "nargs": 0 if boolean else None,
        "const": True if boolean else None,
        "help": help_text,
        "metavar": None,
    }


def command(name, actions, *, groups=()):
    return {
        "name": name,
        "description": None,
        "actions": actions,
        "mutuallyExclusive": [
            {"required": False, "members": list(members)} for members in groups
        ],
    }


COMMAND_RECEIPTS = [
    command("init", []),
    command("paths", []),
    command("profile-get", []),
    command("profile-inspect", []),
    command("profile-replace", [
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
        o("source", required=True, choices=("agent", "migration", "resume", "user")),
    ]),
    command("profile-patch", [
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
        o("source", required=True, choices=("agent", "migration", "resume", "user")),
    ]),
    command("fact-group-list", []),
    command("fact-group-get", [o("id", required=True)]),
    command("fact-group-create", [o("input", required=True)]),
    command("fact-group-update", [
        o("id", required=True),
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("fact-group-delete", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("preferences-get", []),
    command("preferences-set", [
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
        o("source", required=True, choices=("agent", "migration", "resume", "user")),
        o("replace", boolean=True),
    ]),
    command("answer-key", [o("question", required=True), o("scope", default="{}")]),
    command("answer-put", [
        o("input", required=True),
        o("expected-revision", integer=True),
        o("remember-sensitive", boolean=True),
    ]),
    command("answer-get", [o("key", required=True), o("include-trashed", boolean=True)]),
    command("answer-find", [o("question", required=True), o("scope", default="{}")]),
    command("answer-list", [
        o("state"),
        o("review-status", choices=("accepted", "declined", "pending"), default="accepted"),
        o("all-review-statuses", boolean=True),
        o("query", default=""),
        o("offset", integer=True, default=0),
        o("limit", integer=True, default=50),
        o("include-trashed", boolean=True),
        o("trashed-only", boolean=True),
    ], groups=(("review_status", "all_review_statuses"),)),
    command("answer-reveal", [o("key", required=True)]),
    command("answer-observe", [o("input", required=True)]),
    command("answer-review", [
        o("key", required=True),
        o("decision", required=True, choices=("accepted", "declined")),
        o("expected-revision", required=True, integer=True),
        o("input"),
        o("remember-sensitive", boolean=True),
    ]),
    command("answer-update", [
        o("key", required=True),
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
        o("remember-sensitive", boolean=True),
    ]),
    command("answer-trash", [
        o("key", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("answer-restore", [
        o("key", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("answer-delete", [
        o("key", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("answer-merge", [
        o("winner-key", required=True),
        o("source-key", required=True),
        o("expected-winner-revision", required=True, integer=True),
        o("expected-source-revision", required=True, integer=True),
    ]),
    command("answer-semantic-lookup", [o("input", required=True)]),
    command("answer-cleanup-preview", []),
    command("answer-cleanup-approve", [
        o("input", required=True),
        o("owner-confirmed", boolean=True),
    ]),
    command("job-create", [
        o("input", required=True),
        o("origin", choices=("agent", "human"), default="human"),
    ]),
    command("job-upsert-preview", [
        o("input", required=True),
        o("origin", required=True, choices=("agent", "human")),
    ]),
    command("job-upsert-commit", [
        o("input", required=True),
        o("origin", required=True, choices=("agent", "human")),
        o("token", required=True),
    ]),
    command("legacy-jobs-preview", [o("select", default=[], append=True)]),
    command("legacy-jobs-commit", [
        o("select", required=True, append=True),
        o("confirm", required=True),
    ]),
    command("job-get", [o("id", required=True), o("include-trashed", boolean=True)]),
    command("job-list", [
        o("status"),
        o("include-trashed", boolean=True),
        o("trashed-only", boolean=True),
    ]),
    command("job-preflight", [o("id", required=True)]),
    command("job-update", [
        o("id", required=True),
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
        o("origin", choices=("agent", "human"), default="human"),
    ]),
    command("job-transition", [
        o("id", required=True),
        o("status", required=True),
        o("closed-outcome"),
        o("expected-revision", required=True, integer=True),
        o("user-confirmed", boolean=True),
    ]),
    command("job-acquire", [
        o("id", required=True),
        o("owner", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("job-review-restart", [
        o("id", required=True),
        o("owner", required=True),
        o("expected-revision", required=True, integer=True),
        o("owner-confirmed-not-submitted", boolean=True),
    ]),
    command("claim-status", []),
    command("claim-heartbeat", [o("id", required=True), o("token", required=True)]),
    command("claim-recover", [o("id", required=True), o("owner", required=True)]),
    command("claim-progress", [
        o("id", required=True),
        o("token", required=True),
        o("input", required=True),
    ]),
    command("claim-handoff", [
        o("id", required=True),
        o("token", required=True),
        o("status", required=True),
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("attention-approval-preview", [
        o("id", required=True),
        o("expected-job-revision", required=True, integer=True),
        o("expected-session-revision", required=True, integer=True),
        o("input", required=True),
    ]),
    command("attention-approval-approve", [
        o("id", required=True),
        o("expected-job-revision", required=True, integer=True),
        o("expected-session-revision", required=True, integer=True),
        o("preview-token", required=True),
        o("input", required=True),
        o("owner-confirmed", boolean=True),
    ]),
    command("job-trash", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("job-restore", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("job-delete", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("resume-create", [o("input", required=True)]),
    command("resume-import", [o("input", required=True)]),
    command("resume-get", [o("id", required=True), o("include-trashed", boolean=True)]),
    command("resume-resolve", [o("id")]),
    command("resume-list", [o("include-trashed", boolean=True), o("trashed-only", boolean=True)]),
    command("resume-update", [
        o("id", required=True),
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("resume-adopt", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
        o("path"),
    ]),
    command("resume-set-default", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("resume-check", [o("id", required=True)]),
    command("resume-trash", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("resume-restore", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("resume-delete", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("resume-extraction-request-create", [
        o("resume-id", required=True),
        o("expected-resume-revision", required=True, integer=True),
    ]),
    command("resume-extraction-request-get", [o("id", required=True)]),
    command("resume-extraction-request-list", [
        o("resume-id"),
        o("status", choices=("cancelled", "completed", "failed", "requested", "stale")),
    ]),
    command("resume-extraction-request-cancel", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("resume-extraction-request-fail", [
        o("id", required=True),
        o(
            "reason",
            required=True,
            choices=(
                "candidate_invalid", "content_unreadable",
                "extraction_failed", "interrupted",
                "unsupported_resume",
            ),
        ),
        o("expected-revision", required=True, integer=True),
    ]),
    command("resume-extraction-request-retry", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
        o("expected-resume-revision", required=True, integer=True),
    ]),
    command("resume-extraction-request-complete", [
        o("id", required=True),
        o("input", required=True),
        o("expected-request-revision", required=True, integer=True),
        o("expected-profile-revision", required=True, integer=True),
        o("expected-pending-proposal-id"),
    ]),
    command("profile-preparedness-get", []),
    command("resume-proposal-create", [
        o("resume-id", required=True),
        o("expected-resume-revision", required=True, integer=True),
        o("expected-profile-revision", required=True, integer=True),
        o("supersedes"),
        o("input", required=True),
    ]),
    command("resume-proposal-get", [o("id", required=True)]),
    command("resume-proposal-list", [
        o("resume-id"),
        o("status"),
        o("summary-only", boolean=True),
    ]),
    command("resume-proposal-review", [
        o("id", required=True),
        o("expected-revision", required=True, integer=True),
        o("expected-profile-revision", required=True, integer=True),
        o("input", required=True),
    ]),
    command("history-append", [o("input", required=True)]),
    command("history-list", []),
    command("replay-transition", [
        o("id", required=True),
        o("transition", required=True),
        o("ats", required=True),
    ]),
    command("session-save", [o("id", required=True), o("input", required=True)]),
    command("session-load", [o("id", required=True)]),
    command("session-list", []),
    command("session-delete", [o("id", required=True)]),
    command("automation-settings-get", []),
    command("automation-settings-update", [
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("automation-settings-copy-profile-email", [
        o("expected-profile-revision", required=True, integer=True),
        o("expected-settings-revision", required=True, integer=True),
    ]),
    command("automation-capability", [o("platform", choices=("darwin", "linux", "win32"))]),
    command("account-realm-resolve", [o("url", required=True)]),
    command("employer-account-list", []),
    command("employer-account-get", [o("realm-ref", required=True)]),
    command("employer-account-create", [o("url", required=True), o("input")]),
    command("employer-account-update", [
        o("realm-ref", required=True),
        o("input", required=True),
        o("expected-revision", required=True, integer=True),
    ]),
    command("employer-account-execute-synthetic", [o("input", required=True)]),
    command("employer-account-operation-status", []),
    command("employer-account-operation-recover", []),
    command("trusted-fill-approve", [o("input", required=True)]),
    command("trusted-fill-status", [o("id", required=True)]),
    command("trusted-fill-evaluate", [o("input", required=True)]),
    command("trusted-fill-revoke", [
        o("id", required=True),
        o("expected-approval-revision", required=True, integer=True),
    ]),
]


EXPECTED_RECEIPT = {
    "description": (
        "Local, versioned storage helper for the Job Apply plugin. All successful "
        "commands emit JSON on stdout. Errors are deliberately terse and never "
        "include stored values. The helper uses only the Python standard library."
    ),
    "rootActions": [
        o("root", help_text="store directory (default: $JOB_APPLY_STORE_DIR or ~/.job-apply)"),
        o("legacy-profile", help_text="legacy profile path override"),
    ],
    "commands": COMMAND_RECEIPTS,
}


class RecordingStore:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return {"called": name}
        return call


class StoreCliContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module(name="store_cli_contract")

    def test_all_98_commands_have_exact_structural_receipt(self):
        receipt = parser_receipt(self.module.build_parser())
        self.assertEqual(len(receipt["commands"]), 98)
        self.assertEqual(receipt, EXPECTED_RECEIPT)

    def test_parser_and_dispatch_sets_and_order_match(self):
        expected = [item["name"] for item in COMMAND_RECEIPTS]
        self.assertEqual(dispatch_commands(), expected)

    def test_representative_dispatch_argument_shapes(self):
        cases = [
            (
                [
                    "answer-list", "--all-review-statuses", "--query", "Ada",
                    "--offset", "2", "--limit", "7", "--include-trashed",
                ],
                "query_answers",
                (),
                {
                    "query": "Ada", "state": None, "review_status": None,
                    "include_trashed": True, "trashed_only": False,
                    "offset": 2, "limit": 7,
                },
            ),
            (
                [
                    "job-transition", "--id", "job-1", "--status", "closed",
                    "--closed-outcome", "withdrawn", "--expected-revision", "3",
                    "--user-confirmed",
                ],
                "transition_job",
                ("job-1", "closed", 3),
                {"closed_outcome": "withdrawn", "user_confirmed": True},
            ),
            (
                [
                    "resume-proposal-create", "--resume-id", "resume-1",
                    "--expected-resume-revision", "2",
                    "--expected-profile-revision", "4", "--supersedes",
                    "proposal-0", "--input", "input.json",
                ],
                "create_resume_proposal",
                ("resume-1", {"decisions": []}, 2, 4, "proposal-0"),
                {},
            ),
            (
                [
                    "attention-approval-approve", "--id", "job-1",
                    "--expected-job-revision", "5",
                    "--expected-session-revision", "6", "--preview-token",
                    "preview", "--input", "input.json", "--owner-confirmed",
                ],
                "approve_grouped_approval",
                ("job-1", 5, 6, [], "preview"),
                {"owner_confirmed": True},
            ),
            (
                [
                    "trusted-fill-revoke", "--id", "job-1",
                    "--expected-approval-revision", "8",
                ],
                "revoke_trusted_fill", ("job-1", 8), {},
            ),
        ]
        parser = self.module.build_parser()
        for argv, method, args, kwargs in cases:
            with self.subTest(command=argv[0]):
                store = RecordingStore()
                original_resolve = self.module.resolve_store
                original_read = self.module._read_input
                self.module.resolve_store = lambda _args: store
                self.module._read_input = lambda _path: {"decisions": []}
                try:
                    self.module.run(parser.parse_args(argv))
                finally:
                    self.module.resolve_store = original_resolve
                    self.module._read_input = original_read
                self.assertEqual(store.calls, [(method, args, kwargs)])

    def test_root_and_every_command_help_exit_cleanly_without_store_construction(self):
        probe = """
import importlib.util, json, sys
script, argv_json = sys.argv[1:]
spec = importlib.util.spec_from_file_location('help_probe_store', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class BombStore:
    def __init__(self, *args, **kwargs):
        raise AssertionError('help constructed Store')
module.Store = BombStore
sys.argv = [script, *json.loads(argv_json)]
raise SystemExit(module.main())
"""
        forms = [["--help"], *[[item["name"], "--help"] for item in COMMAND_RECEIPTS]]
        for argv in forms:
            with self.subTest(argv=argv):
                result = subprocess.run(
                    [sys.executable, "-c", probe, str(SCRIPT), json.dumps(argv)],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                self.assertTrue(result.stdout.startswith("usage:"))


if __name__ == "__main__":
    unittest.main()
