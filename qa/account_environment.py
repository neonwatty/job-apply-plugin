"""Environment setup for owner-approved visible-browser account QA."""


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
        "--disable-background-networking", "--disable-component-update",
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
