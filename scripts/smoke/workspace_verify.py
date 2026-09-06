#!/usr/bin/env python3
"""workspace verification smoke assertions."""

import argparse
from pathlib import Path


def run(fixture: Path, smoke_root: Path) -> None:
    import base64
    import http.client
    import importlib.util
    import json
    import signal
    import subprocess
    import sys
    from pathlib import Path
    from urllib.parse import urlsplit

    fixture = Path(fixture)
    smoke_root = Path(smoke_root)
    launcher = fixture / "scripts" / "job-apply-workspace.py"
    assets = [fixture / "workspace" / name for name in ("index.html", "app.js", "styles.css")]
    if not launcher.is_file() or not all(asset.is_file() for asset in assets):
        raise SystemExit("packaged fixture is missing the Jobs workspace launcher or assets")

    store_spec = importlib.util.spec_from_file_location("packaged_merge_store", fixture / "scripts" / "job-apply-store.py")
    store_module = importlib.util.module_from_spec(store_spec)
    store_spec.loader.exec_module(store_module)
    parser = store_module.build_parser()
    subcommands = next(action.choices for action in parser._actions if action.dest == "command")
    required_extraction_commands = {
        "resume-extraction-request-create",
        "resume-extraction-request-list",
        "resume-extraction-request-get",
        "resume-extraction-request-cancel",
        "resume-extraction-request-fail",
        "resume-extraction-request-retry",
        "resume-extraction-request-complete",
        "profile-preparedness-get",
    }
    if not required_extraction_commands.issubset(subcommands):
        raise SystemExit("packaged Store parser is missing extraction or preparedness commands")
    sys.path.insert(0, str(fixture))
    from scripts.skill_documents import skill_text

    packaged_job_apply = skill_text(fixture / "skills/job-apply/SKILL.md")
    packaged_workspace = skill_text(fixture / "skills/job-workspace/SKILL.md")
    if "Stop at proposal review" not in packaged_job_apply or "does not start or launch an agent" not in packaged_workspace:
        raise SystemExit("packaged skills do not preserve the extraction handoff boundary")
    packaged_app = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((fixture / "workspace").rglob("*.js"))
    )
    if packaged_app.count('"/api/resume-extraction-requests"') != 1:
        raise SystemExit("packaged workspace request collection route changed unexpectedly")
    for allowed_action in ("cancel", "retry"):
        expected_route = f'path += `/${{encodeURIComponent(request.requestId)}}/{allowed_action}`'
        if expected_route not in packaged_app:
            raise SystemExit(f"packaged workspace is missing allowed request endpoint /{allowed_action}")
    for forbidden_suffix in ("/complete", "/fail", "/candidate"):
        if f"resume-extraction-requests{forbidden_suffix}" in packaged_app:
            raise SystemExit(f"packaged workspace exposes forbidden request endpoint {forbidden_suffix}")
    recovery_store = store_module.Store(smoke_root / "merge-recovery-store", smoke_root / "no-legacy")
    winner = recovery_store.put_answer({"question": "Packaged merge winner?", "state": "sensitive", "value": "packaged-winner-secret", "sensitivity": "high"}, remember_sensitive=True)
    source = recovery_store.put_answer({"question": "Packaged merge duplicate?", "state": "confirmed", "value": "packaged-source-discarded"})
    recovery_store.save_session("packaged-merge", {"status": "active", "answerKeys": [source["key"]]})
    recovery_store.append_history({"applicationId": "packaged-merge", "event": "reviewed", "answerKeys": [source["key"]]})
    real_atomic_write = store_module.atomic_write_json
    interrupted = False
    def interrupt_merge(path, payload):
        nonlocal interrupted
        if path == recovery_store._session_path("packaged-merge") and not interrupted:
            interrupted = True
            raise OSError("synthetic packaged merge interruption")
        return real_atomic_write(path, payload)
    store_module.atomic_write_json = interrupt_merge
    try:
        recovery_store.merge_answers(winner["key"], source["key"], winner["revision"], source["revision"])
        raise SystemExit("packaged merge recovery did not interrupt")
    except OSError:
        pass
    finally:
        store_module.atomic_write_json = real_atomic_write
    recovered_store = store_module.Store(recovery_store.root, smoke_root / "no-legacy")
    recovered_store.initialize()
    merged = recovered_store.get_answer(winner["key"])
    redirected = recovered_store.get_answer(source["key"])
    session = recovered_store.load_session("packaged-merge")
    if redirected.get("key") != winner["key"] or session.get("answerKeys") != [winner["key"]] or merged.get("referenceCounts", {}).get("history") != 1:
        raise SystemExit("packaged merge recovery or immutable-history resolution failed")
    if "packaged-source-discarded" in recovery_store.answers_path.read_text(encoding="utf-8") or "packaged-winner-secret" in recovery_store.coordinator_journal_path.read_text(encoding="utf-8"):
        raise SystemExit("packaged merge recovery retained a source value or journaled an answer value")
    process = subprocess.Popen(
        [sys.executable, str(launcher), "--root", str(smoke_root / "workspace-store"), "--port", "0", "--no-open", "--json"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        details = json.loads(process.stdout.readline())
        parsed = urlsplit(details["url"])
        token = parsed.fragment.removeprefix("token=")
        connection = http.client.HTTPConnection("127.0.0.1", details["port"], timeout=5)
        host = f"127.0.0.1:{details['port']}"
        connection.request("GET", "/", headers={"Host": host})
        response = connection.getresponse()
        markup = response.read()
        if response.status != 200 or any(label not in markup for label in (b"Jobs Workspace", b"Facts Workspace", b"Resumes Workspace", b"Unified recovery")):
            raise SystemExit("packaged workspace did not serve its Jobs, Facts, Resumes, and Trash UI")
        connection.request("GET", "/api/state", headers={"Host": host, "Authorization": f"Bearer {token}"})
        response = connection.getresponse()
        state = json.loads(response.read())
        if response.status != 200 or state != {"jobs": [], "resumes": []}:
            raise SystemExit("packaged workspace did not read the canonical store")
        connection.request("GET", "/api/profile", headers={"Host": host, "Authorization": f"Bearer {token}"})
        response = connection.getresponse()
        profile = json.loads(response.read())
        if response.status != 200 or profile.get("profile") != {} or profile.get("revision") != 1:
            raise SystemExit("packaged workspace did not inspect the canonical profile")
        store_cli = [sys.executable, str(fixture / "scripts" / "job-apply-store.py"), "--root", str(smoke_root / "workspace-store")]
        created_job = json.loads(subprocess.run(
            [*store_cli, "job-create", "--input", "-"],
            input=json.dumps({"id": "trash-smoke-job", "url": "https://private.example/jobs/trash-smoke", "role": "Trash smoke"}),
            capture_output=True, text=True, check=True,
        ).stdout)
        trashed_job = json.loads(subprocess.run(
            [*store_cli, "job-trash", "--id", created_job["id"], "--expected-revision", str(created_job["revision"])],
            capture_output=True, text=True, check=True,
        ).stdout)
        trash_only = json.loads(subprocess.run(
            [*store_cli, "job-list", "--trashed-only"], capture_output=True, text=True, check=True,
        ).stdout)
        if [item.get("id") for item in trash_only] != [created_job["id"]]:
            raise SystemExit("packaged job trash-only CLI filtering failed")
        connection.request("GET", "/api/trash", headers={"Host": host, "Authorization": f"Bearer {token}"})
        response = connection.getresponse()
        unified = json.loads(response.read())
        if response.status != 200 or unified.get("counts", {}).get("job") != 1 or "private.example" in json.dumps(unified):
            raise SystemExit("packaged unified Trash projection was missing or exposed a job URL")
        restore_body = json.dumps({"expectedRevision": trashed_job["revision"]}).encode()
        connection.request("POST", f"/api/jobs/{created_job['id']}/restore", body=restore_body, headers={
            "Host": host, "Authorization": f"Bearer {token}", "Origin": f"http://{host}",
            "Content-Type": "application/json", "Content-Length": str(len(restore_body)),
        })
        response = connection.getresponse()
        restored_job = json.loads(response.read())
        if response.status != 200 or restored_job.get("deletedAt") is not None:
            raise SystemExit("packaged workspace job restore parity failed")
        source = smoke_root / "managed-smoke.txt"
        source.write_text("packaged managed resume", encoding="utf-8")
        created = subprocess.run(
            [
                sys.executable,
                str(fixture / "scripts" / "job-apply-store.py"),
                "--root",
                str(smoke_root / "workspace-store"),
                "resume-import",
                "--input",
                "-",
            ],
            input=json.dumps({"id": "smoke-resume", "label": "Smoke", "path": str(source)}),
            capture_output=True,
            text=True,
            check=True,
        )
        managed = json.loads(created.stdout)
        if managed.get("storageKind") != "managed" or "path" in managed:
            raise SystemExit("packaged resume import did not create a managed record")
        proposal_result = subprocess.run(
            [
                sys.executable,
                str(fixture / "scripts" / "job-apply-store.py"),
                "--root",
                str(smoke_root / "workspace-store"),
                "resume-proposal-create",
                "--resume-id",
                managed["id"],
                "--expected-resume-revision",
                str(managed["revision"]),
                "--expected-profile-revision",
                "1",
                "--input",
                "-",
            ],
            input=json.dumps({"email": "smoke@example.invalid"}),
            capture_output=True,
            text=True,
            check=True,
        )
        proposal = json.loads(proposal_result.stdout)
        if proposal.get("status") != "completed" or proposal.get("autoFilledPaths") != ["/email"]:
            raise SystemExit("packaged resume proposal did not auto-fill an empty fact")
        listed_result = subprocess.run(
            [
                sys.executable,
                str(fixture / "scripts" / "job-apply-store.py"),
                "--root",
                str(smoke_root / "workspace-store"),
                "resume-proposal-list",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        if len(json.loads(listed_result.stdout)) != 1:
            raise SystemExit("packaged resume proposal was not durable")
        source.unlink()
        connection.request("GET", "/api/resumes", headers={"Host": host, "Authorization": f"Bearer {token}"})
        response = connection.getresponse()
        projected = json.loads(response.read())
        records = projected.get("resumes", [])
        if response.status != 200 or len(records) != 1 or any(
            field in records[0] for field in ("path", "managedFile", "originalFilename", "digest")
        ):
            raise SystemExit("packaged workspace exposed private resume identity")
        upload = json.dumps({
            "metadata": {"id": "smoke-browser", "label": "Browser smoke"},
            "filename": "private-smoke-name.txt",
            "content": base64.b64encode(b"private browser smoke").decode("ascii"),
        }).encode()
        connection.request("POST", "/api/resumes/import", body=upload, headers={
            "Host": host, "Authorization": f"Bearer {token}", "Origin": f"http://{host}",
            "Content-Type": "application/json", "Content-Length": str(len(upload)),
        })
        response = connection.getresponse()
        imported = json.loads(response.read())
        if response.status != 200 or imported.get("id") != "smoke-browser":
            raise SystemExit("packaged workspace resume upload failed")
        connection.request("GET", "/api/resumes/smoke-browser/content", headers={"Host": host, "Authorization": f"Bearer {token}"})
        response = connection.getresponse()
        content = response.read()
        headers = dict(response.getheaders())
        if response.status != 200 or content != b"private browser smoke" or headers.get("Cache-Control") != "no-store" or "private-smoke-name" in headers.get("Content-Disposition", ""):
            raise SystemExit("packaged workspace private content delivery failed")
        connection.close()
        process.send_signal(signal.SIGINT)
        if process.wait(timeout=5) != 0:
            raise SystemExit("packaged workspace did not shut down cleanly")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
    print("Packaged Jobs, Facts, managed resume, extraction, Answers merge recovery, unified Trash API, and store launch passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path)
    parser.add_argument("smoke_root", type=Path)
    arguments = parser.parse_args()
    run(arguments.fixture, arguments.smoke_root)


if __name__ == "__main__":
    main()
