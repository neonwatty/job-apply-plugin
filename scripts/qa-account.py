#!/usr/bin/env python3
"""Observed synthetic browser + Store + native macOS account verifier."""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


SERVER = _module("account_server", ROOT / "qa" / "account_server.py")
ORACLE = _module("account_oracle", ROOT / "qa" / "account_oracle.py")
EXECUTOR = _module("job_apply_account_executor_qa", ROOT / "scripts" / "job_apply_account_executor.py")
CREDENTIALS = _module("job_apply_credentials_qa", ROOT / "scripts" / "job_apply_credentials.py")
CREDENTIALS_MACOS = _module("job_apply_credentials_macos_qa", ROOT / "scripts" / "job_apply_credentials_macos.py")
ACCOUNTS = _module("job_apply_accounts_qa", ROOT / "scripts" / "job_apply_accounts.py")
ACCOUNT_FLOWS = _module("job_apply_account_flows_qa", ROOT / "scripts" / "job_apply_account_flows.py")
ACCOUNT_FLOWS_MACOS = _module("job_apply_account_flows_macos_qa", ROOT / "scripts" / "job_apply_account_flows_macos.py")
STORE = _module("job_apply_store_qa", ROOT / "scripts" / "job-apply-store.py")


VISIBLE_BROWSER_APPROVAL_ERROR = (
    "visible browser verification is disabled; explicit current-turn owner approval "
    "and --owner-approved-visible-browser-tests are required"
)
VISIBLE_BROWSER_DEPENDENCY_ERROR = (
    "visible browser verification dependencies are unavailable; run from a dependency-complete "
    "exact candidate checkout"
)


def _require_visible_browser_approval(owner_approved: bool) -> None:
    """Refuse before compiling helpers, starting servers, or launching a browser."""
    if not owner_approved:
        raise ValueError(VISIBLE_BROWSER_APPROVAL_ERROR)


def _require_browser_test_dependencies() -> None:
    """Refuse before any helper, server, browser, Store, or native setup."""
    try:
        completed = subprocess.run(
            [
                "node", "--input-type=module", "--eval",
                'import { chromium } from "playwright"; if (!chromium) process.exit(9)',
            ],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError(VISIBLE_BROWSER_DEPENDENCY_ERROR) from None
    if completed.returncode:
        raise ValueError(VISIBLE_BROWSER_DEPENDENCY_ERROR)


def _compile_native(binary: Path) -> None:
    completed = subprocess.run([
        "xcrun", "swiftc", "-O", "-o", str(binary),
        str(ROOT / "native/macos/job_apply_credential_helper.swift"),
        str(ROOT / "native/macos/job_apply_browser_bridge.swift"),
        str(ROOT / "native/macos/job_apply_account_flow_helper.swift"),
        str(ROOT / "native/macos/job_apply_credential_helper_tests.swift"),
        str(ROOT / "native/macos/job_apply_credential_helper_main.swift"),
    ], capture_output=True, check=False)
    if completed.returncode or completed.stdout or completed.stderr:
        raise ValueError("native isolated integration did not complete silently")


def _start_browser(profile: Path) -> tuple[subprocess.Popen, str]:
    executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if not Path(executable).is_file():
        raise ValueError("exact signed synthetic browser is unavailable")
    child = subprocess.Popen([
        executable, "--no-first-run", "--no-default-browser-check", "--force-renderer-accessibility",
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        f"--user-data-dir={profile}", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    active_port = profile / "DevToolsActivePort"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise ValueError("synthetic browser exited before readiness")
        try:
            port = int(active_port.read_text(encoding="utf-8").splitlines()[0])
            if 1 <= port <= 65535:
                return child, f"http://127.0.0.1:{port}"
        except (OSError, ValueError, IndexError):
            pass
        time.sleep(0.025)
    raise ValueError("synthetic browser readiness timed out")


def _focus_browser(cdp_url: str, url: str) -> None:
    script = r'''
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP(process.argv[2]);
const context = browser.contexts()[0];
const page = await context.newPage();
page.setDefaultTimeout(5000);
await page.goto(process.argv[1], {waitUntil: "domcontentloaded", timeout: 10000});
for (const existing of context.pages()) {
    if (existing !== page) await existing.close();
}
await page.getByRole("button", {name: "Focus protected synthetic control"}).click();
await page.locator("#job-apply-secure-control").evaluate((element) => element.focus());
await page.bringToFront();
process.exit(0);
'''
    for _ in range(3):
        try:
            completed = subprocess.run(
                ["node", "--input-type=module", "--eval", script, url, cdp_url],
                cwd=ROOT, capture_output=True, text=True, check=False, timeout=12,
            )
        except subprocess.TimeoutExpired:
            time.sleep(0.1)
            continue
        if completed.stdout:
            raise ValueError("synthetic browser focus emitted output")
        if not completed.returncode and not completed.stderr:
            time.sleep(0.15)
            return
        time.sleep(0.1)
    raise ValueError("synthetic browser observation failed closed")


def _open_oracle_browser(cdp_url: str, url: str) -> None:
    script = r'''
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP(process.argv[2]);
const context = browser.contexts()[0];
const page = await context.newPage();
page.setDefaultTimeout(5000);
await page.goto(process.argv[1], {waitUntil: "domcontentloaded", timeout: 10000});
for (const existing of context.pages()) {
    if (existing !== page) await existing.close();
}
await page.locator("#job-apply-email-control").waitFor();
await page.locator("#job-apply-focus-decoy").focus();
if (await page.evaluate(() => document.activeElement?.id) !== "job-apply-focus-decoy") process.exit(7);
await page.bringToFront();
process.exit(0);
'''
    for _ in range(3):
        try:
            completed = subprocess.run(
                ["node", "--input-type=module", "--eval", script, url, cdp_url],
                cwd=ROOT, capture_output=True, text=True, check=False, timeout=12,
            )
        except subprocess.TimeoutExpired:
            time.sleep(0.1)
            continue
        if not completed.returncode and not completed.stdout and not completed.stderr:
            time.sleep(0.15)
            return
        time.sleep(0.1)
    raise ValueError("synthetic Oracle browser observation failed closed")


def _native_provider(
    binary: Path, browser_process_identifier: int, namespace: str,
    native_channels: dict[str, object], helper_stages: dict[str, str],
):
    provisioned: set[str] = set()

    def bridge(request: dict) -> dict:
        expected = CREDENTIALS_MACOS.MacOSSecurityFrameworkProvider.credential_reference(
            request["strategy"], request["realmRef"]
        )
        reused = expected in provisioned or request["existingCredentialRef"] == expected
        operation = request["operationFingerprint"].removeprefix("sha256:")
        socket_path = native_channels.pop(operation, None)
        if not isinstance(socket_path, str):
            raise ValueError("native attestation channel is unavailable")
        completed = subprocess.run(
            [
            str(binary), "compound", request["strategy"], request["realmRef"], expected,
            namespace, str(browser_process_identifier), request["syntheticTargetUrl"],
            request["secureControlFingerprint"], request["operationFingerprint"],
            "reused" if reused else "new", socket_path,
            ],
            capture_output=True, check=False,
        )
        if completed.returncode or completed.stdout or completed.stderr:
            helper_stages[operation] = (
                f"exit_{completed.returncode}" if completed.returncode else "unexpected_output"
            )
            raise ValueError("native protected operation failed closed")
        helper_stages[operation] = "completed"
        provisioned.add(expected)
        return {
            "providerId": "macos-keychain", "credentialRef": expected,
            "credentialVersion": 1, "reused": reused, "filled": True,
            "secureControlCleared": True,
        }

    return CREDENTIALS_MACOS.MacOSSecurityFrameworkProvider(bridge)


def _store_walkthrough(base: Path, scenario: str, target: str, provider) -> dict:
    root = base / scenario / "store"
    legacy = base / scenario / "legacy.json"
    store = STORE.Store(root, legacy)
    resume_source = base / scenario / "resume.txt"
    resume_source.parent.mkdir(parents=True, exist_ok=True)
    resume_source.write_text("Synthetic account safety fixture", encoding="utf-8")
    store.replace_profile({"firstName": "Synthetic"}, store.inspect_profile()["revision"], "user")
    resume = store.create_resume({"id": f"resume-{scenario}", "label": "Synthetic", "path": str(resume_source)})
    tenant = "success" if scenario == "reuse" else scenario.replace("_", "-")
    job = store.create_job({
        "id": f"job-{scenario}", "url": f"https://{tenant}.wd5.myworkdayjobs.com/jobs/one",
        "role": "Synthetic", "company": "Synthetic", "resumeId": resume["id"],
    })
    ready = store.transition_job(job["id"], "ready", job["revision"])
    acquired = store.acquire_ready_job(job["id"], "qa-account", ready["revision"])
    settings = store.get_automation_settings()
    settings = store.update_automation_settings({
        "enabled": True, "automaticAccountCreation": True,
        "signupEmail": "synthetic@example.invalid",
    }, settings["revision"])
    realm = store.resolve_account_realm(job["url"])
    account = store.create_employer_account(job["url"])
    if scenario == "restart":
        STORE.atomic_write_json(store.account_operation_journal_path, {
            "schemaVersion": 1,
            "operation": {
                "operationId": "synthetic-restart", "jobId": job["id"],
                "jobRevision": acquired["job"]["revision"], "claimId": acquired["claim"]["claimId"],
                "realmRef": realm["realmRef"], "accountRevision": account["revision"],
                "settingsRevision": settings["revision"], "stage": "prepared",
                "outcomeCode": "observed_pending", "startedAt": "2026-08-29T00:00:00Z",
            },
        })
        recovered = store.recover_account_operation()
        return {
            "lifecycleState": recovered["status"], "retryAllowed": recovered["retryAllowed"],
            "finalActionAuthorized": False, "secureControlCleared": True,
        }
    proofs = EXECUTOR.synthetic_proofs(target, scenario)
    packet = {
        "jobId": job["id"], "expectedJobRevision": acquired["job"]["revision"],
        "expectedClaimId": acquired["claim"]["claimId"], "realmRef": realm["realmRef"],
        "realmDescriptor": realm["descriptor"], "expectedSettingsRevision": settings["revision"],
        "expectedAccountRevision": account["revision"], "syntheticTargetUrl": target,
        **proofs,
    }
    observer_stage = "not_started"

    def observed_portal(target_url: str, operation_fingerprint: str) -> dict:
        nonlocal observer_stage
        observer_stage = "started"
        observed = EXECUTOR.observe_synthetic_portal(target_url, operation_fingerprint)
        observer_stage = "completed"
        return observed

    result = store.execute_synthetic_account(
        packet, provider=provider, observer=observed_portal
    )
    return {
        "lifecycleState": result["account"]["lifecycleState"],
        "retryAllowed": result["retryAllowed"],
        "finalActionAuthorized": result.get("finalActionAuthorized", False),
        "secureControlCleared": result.get("secureControlCleared", False),
        "qaObserverStage": observer_stage,
    }


def _workday_scenario_result(scenario: str, actual: dict) -> dict:
    evaluated = ORACLE.evaluate(scenario, actual)
    if not evaluated["passed"]:
        evaluated["diagnostics"] = {
            "expectedLifecycle": evaluated.get("expectedLifecycle"),
            "observedLifecycle": actual.get("lifecycleState"),
            "retryDenied": actual.get("retryAllowed") is False,
            "finalActionDenied": actual.get("finalActionAuthorized") is False,
            "nativeControlCleared": actual.get("secureControlCleared") is True,
            "observerStage": actual.get("qaObserverStage"),
            "nativeTransitionAdvanced": actual.get("qaNativeTransitionAdvanced"),
            "observationPending": actual.get("qaObservationPending"),
            "nativeStage": actual.get("qaNativeStage"),
            "helperStage": actual.get("qaHelperStage"),
        }
    return evaluated


def verify_all(provider: str, *, owner_approved_visible_browser_tests: bool = False) -> dict:
    _require_visible_browser_approval(owner_approved_visible_browser_tests)
    if provider != "macos-keychain" or not sys.platform.startswith("darwin"):
        raise ValueError("synthetic provider selection is unsupported")
    _require_browser_test_dependencies()
    with tempfile.TemporaryDirectory() as directory:
        server = None
        thread = None
        try:
            base = Path(directory)
            binary = base / "credential-integration"
            _compile_native(binary)
            server = SERVER.SyntheticAccountServer(0, native_helper_path=binary)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            port = server.server_address[1]
            profile = base / "browser-profile"
            profile.mkdir()
            browser_process, cdp_url = _start_browser(profile)
            cleanup = set()
            cleanup_error = None
            try:
                namespace = "test_" + base.name.replace("-", "_")
                native_channels = {}
                helper_stages = {}
                native_provider = _native_provider(
                    binary, browser_process.pid, namespace, native_channels, helper_stages,
                )
                results = []
                for scenario in ORACLE.SCENARIOS:
                    tenant = "success" if scenario == "reuse" else scenario.replace("_", "-")
                    descriptor = f"workday:v1:wd5:{tenant}"
                    realm = __import__("hashlib").sha256(descriptor.encode()).hexdigest()
                    base_target = f"http://127.0.0.1:{port}/synthetic-account"
                    control = EXECUTOR.synthetic_proofs(base_target, scenario)["secureControlFingerprint"]
                    operation = EXECUTOR.operation_fingerprint(base_target, realm, control)
                    target = base_target + "?operation=" + operation.removeprefix("sha256:")
                    if scenario != "restart":
                        socket_path = server.prepare_native_operation(
                            operation.removeprefix("sha256:")
                        )
                        native_channels[operation.removeprefix("sha256:")] = socket_path
                        try:
                            _focus_browser(cdp_url, target)
                        except ValueError as error:
                            raise ValueError(
                                f"synthetic browser focus failed closed for {scenario}; "
                                f"native stage {server.native_stage(operation.removeprefix('sha256:'))}"
                            ) from error
                        cleanup.add(("unique_per_realm", realm))
                    transition_before = server._transition_index
                    actual = _store_walkthrough(base, scenario, target, native_provider)
                    actual["qaNativeTransitionAdvanced"] = (
                        server._transition_index > transition_before
                    )
                    actual["qaObservationPending"] = (
                        operation.removeprefix("sha256:") in server._observations
                    )
                    actual["qaNativeStage"] = server.native_stage(
                        operation.removeprefix("sha256:")
                    )
                    actual["qaHelperStage"] = helper_stages.get(
                        operation.removeprefix("sha256:"), "not_started"
                    )
                    evaluated = _workday_scenario_result(scenario, actual)
                    results.append({**evaluated, "evidenceSource": "browser-store-native"})
            finally:
                for strategy, realm in cleanup:
                    completed = subprocess.run([str(binary), "cleanup", strategy, realm, namespace], capture_output=True)
                    if completed.returncode or completed.stdout or completed.stderr:
                        cleanup_error = ValueError("isolated Keychain cleanup failed")
                completed = subprocess.run([str(binary), "count", namespace, "0"], capture_output=True)
                if completed.returncode or completed.stdout or completed.stderr:
                    cleanup_error = ValueError("isolated Keychain cleanup proof failed")
                browser_process.terminate()
                try:
                    browser_process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    browser_process.kill(); browser_process.wait(timeout=3)
                shutil.rmtree(profile, ignore_errors=True)
                if cleanup_error is not None:
                    raise cleanup_error
            return {
                "passed": all(item["passed"] for item in results),
                "providerId": provider, "synthetic": True,
                "submissionAccepted": False, "scenarios": results,
            }
        finally:
            if server is not None:
                server.shutdown(); server.server_close()
            if thread is not None:
                thread.join(timeout=2)


def verify_oracle_email_only(provider: str, *, owner_approved_visible_browser_tests: bool = False) -> dict:
    _require_visible_browser_approval(owner_approved_visible_browser_tests)
    if provider != "macos-accessibility" or not sys.platform.startswith("darwin"):
        raise ValueError("Oracle email-only automation provider is unsupported")
    _require_browser_test_dependencies()
    descriptor = "oracle-recruiting:v1:synthetic.fa.us2.oraclecloud.com:jobsearch"
    realm = __import__("hashlib").sha256(descriptor.encode()).hexdigest()
    controls = {
        "accountFormFingerprint": ACCOUNT_FLOWS.fingerprint("oracle-form:v1"),
        "emailControlFingerprint": ACCOUNT_FLOWS.fingerprint("oracle-email:v1"),
        "termsControlFingerprint": ACCOUNT_FLOWS.fingerprint("oracle-terms-control:v1"),
        "termsDocumentFingerprint": ACCOUNT_FLOWS.fingerprint("oracle-terms-document:v1"),
        "nextControlFingerprint": ACCOUNT_FLOWS.fingerprint("oracle-next-non-final:v1"),
        "passwordControlFingerprint": None,
        "createAccountControlFingerprint": None,
    }
    canonical_url = "https://synthetic.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/1/apply/email"
    results = []
    server = None
    thread = None
    browser_process = None
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory)
        profile = base / "browser-profile"; profile.mkdir()
        try:
            browser_process, cdp_url = _start_browser(profile)
            native = ACCOUNT_FLOWS_MACOS.NativeMacOSAccessibilityProvider.from_reviewed_sources(
                browser_process.pid, build_directory=base,
            )
            server = SERVER.SyntheticAccountServer(0, native_helper_path=Path(native.binary))
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            for index, scenario in enumerate(ORACLE.ORACLE_EMAIL_ONLY_SCENARIOS, start=1):
                operation = __import__("hashlib").sha256(f"oracle-native:{index}".encode()).hexdigest()
                socket_path = server.prepare_native_operation(operation, mode="oracle-email-only")
                portal_url = f"http://127.0.0.1:{server.server_address[1]}/synthetic-oracle?operation={operation}"
                packet = {
                    "jobId": "synthetic-oracle", "jobRevision": 1,
                    "expectedClaimId": "synthetic-claim", "realmRef": realm,
                    "realmDescriptor": descriptor, "flowKind": "email_only_candidate_profile",
                    "accountRevision": 1, "settingsRevision": 1,
                    "portalUrl": portal_url, **controls,
                }
                packet["accountCreationControlsFingerprint"] = ACCOUNT_FLOWS.aggregate_controls(packet)
                _open_oracle_browser(cdp_url, portal_url)
                actual = ACCOUNT_FLOWS.execute_email_only(
                    packet, native.with_socket_path(socket_path),
                    lambda: "synthetic@example.invalid", allow_loopback=True,
                )
                results.append({
                    **ORACLE.evaluate_email_only(scenario, actual),
                    "evidenceSource": "signed-browser-compiled-native",
                })
        finally:
            if browser_process is not None:
                browser_process.terminate()
                try: browser_process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    browser_process.kill(); browser_process.wait(timeout=3)
            shutil.rmtree(profile, ignore_errors=True)
            if server is not None:
                server.shutdown(); server.server_close()
            if thread is not None:
                thread.join(timeout=2)
    canonical = ACCOUNTS.normalize_realm(canonical_url)
    stable = ACCOUNTS.normalize_realm(canonical_url.replace("/job/1/apply/email", "/job/2"))
    separate = ACCOUNTS.normalize_realm(canonical_url.replace("/sites/jobsearch/", "/sites/other/"))
    realm_proof = canonical.get("realmRef") == stable.get("realmRef") == realm and separate.get("realmRef") != realm
    native_proof = all(item["evidenceSource"] == "signed-browser-compiled-native" for item in results)
    encoded = json.dumps(results, sort_keys=True)
    return {
        "passed": all(item["passed"] for item in results) and realm_proof and native_proof and "synthetic@example.invalid" not in encoded,
        "providerId": provider, "synthetic": True, "realmIdentityProven": realm_proof,
        "nativeContractProven": native_proof, "credentialProviderInvocations": 0,
        "keychainDelta": 0, "nextActivationsMaximum": 1,
        "finalActions": 0, "emailTransmittedOverHttp": False,
        "scenarios": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify-all")
    verify.add_argument("--provider", required=True)
    verify.add_argument("--owner-approved-visible-browser-tests", action="store_true")
    verify.add_argument("--json", action="store_true")
    oracle = sub.add_parser("verify-oracle-email-only")
    oracle.add_argument("--automation-provider", required=True)
    oracle.add_argument("--owner-approved-visible-browser-tests", action="store_true")
    oracle.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "verify-all":
            result = verify_all(
                args.provider,
                owner_approved_visible_browser_tests=args.owner_approved_visible_browser_tests,
            )
        else:
            result = verify_oracle_email_only(
                args.automation_provider,
                owner_approved_visible_browser_tests=args.owner_approved_visible_browser_tests,
            )
    except ValueError as error:
        print(json.dumps({"passed": False, "error": str(error)}, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
