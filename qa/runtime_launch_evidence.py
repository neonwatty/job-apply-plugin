#!/usr/bin/env python3
"""Node-independent, non-certifying runtime observation; never a launcher."""

import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading


TIMEOUT_SECONDS = 2
OUTPUT_LIMIT = 256
ENVIRONMENTS = ("inherited-path", "node-free-simulation")
HOSTS = ("none", "codex", "claude")


def run_version(environment):
    """Resolve only the chosen PATH, isolate cwd, and bound both output pipes."""
    with tempfile.TemporaryDirectory(prefix="runtime-evidence-") as directory:
        child_env = {
            key: os.environ[key]
            for key in ("SystemRoot", "WINDIR", "TEMP", "TMP")
            if key in os.environ
        }
        child_env["PATH"] = (
            directory if environment == "node-free-simulation"
            else os.environ.get("PATH", "")
        )
        # Windows executable lookup may consult cwd independently of PATH.
        # Simulation deliberately never resolves or starts an executable.
        if environment == "node-free-simulation":
            raise FileNotFoundError()
        executable = shutil.which("node", path=child_env["PATH"])
        if executable is None:
            raise FileNotFoundError()
        process = subprocess.Popen(
            [str(Path(executable).resolve()), "--version"],
            cwd=directory, env=child_env, shell=False,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        output = [b"", b""]
        overflow = threading.Event()

        def collect(index, stream):
            # One bounded read per pipe; overflow cannot accumulate in memory.
            invalid = False
            try:
                output[index] = stream.read(OUTPUT_LIMIT + 1)
            except OSError:
                invalid = True
            if invalid or len(output[index]) > OUTPUT_LIMIT:
                overflow.set()
                try:
                    process.kill()
                except OSError:
                    pass

        readers = [
            threading.Thread(target=collect, args=(index, stream), daemon=True)
            for index, stream in enumerate((process.stdout, process.stderr))
        ]
        for reader in readers:
            reader.start()
        try:
            process.wait(timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=TIMEOUT_SECONDS)
            raise
        finally:
            for reader in readers:
                reader.join(timeout=TIMEOUT_SECONDS)
            # Do not block closing a pipe held by an unexpected descendant.
            for reader, stream in zip(readers, (process.stdout, process.stderr)):
                if not reader.is_alive():
                    stream.close()
        if any(reader.is_alive() for reader in readers):
            raise subprocess.TimeoutExpired("node", TIMEOUT_SECONDS)
        if overflow.is_set():
            raise ValueError()
        return subprocess.CompletedProcess("node", process.returncode, *output)


def observe_runtime(environment="inherited-path", host_claim="none", *, runner=run_version):
    if environment not in ENVIRONMENTS or host_claim not in HOSTS:
        raise ValueError("unsupported evidence classification")
    receipt = {
        "schemaVersion": 1,
        "platform": sys.platform if sys.platform in ("linux", "darwin", "win32") else "unknown",
        "arch": {"x86_64": "x64", "AMD64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(
            platform.machine(), "unknown"
        ),
        "environment": environment,
        "hostClaim": host_claim,
        "provenance": "unverified-self-report",
        "freshHostVerified": False,
        "nodeAvailable": False,
        "nodeVersion": None,
        "nodeStatus": "unavailable",
        "launchMode": "unresolved",
    }
    try:
        result = runner(environment)
        if result.returncode != 0:
            return receipt
        if not isinstance(result.stdout, bytes) or result.stderr != b"":
            receipt["nodeStatus"] = "invalid-output"
            return receipt
        version = re.fullmatch(rb"v(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\r?\n?", result.stdout)
        if len(result.stdout) > OUTPUT_LIMIT or version is None:
            receipt["nodeStatus"] = "invalid-output"
            return receipt
        receipt["nodeAvailable"] = True
        receipt["nodeVersion"] = b".".join(version.groups()).decode("ascii")
        receipt["nodeStatus"] = "candidate" if int(version[1]) >= 22 else "unsupported"
    except subprocess.TimeoutExpired:
        receipt["nodeStatus"] = "timeout"
    except ValueError:
        receipt["nodeStatus"] = "invalid-output"
    except (OSError, subprocess.SubprocessError):
        pass
    return receipt


class PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "invalid runtime evidence arguments\n")


def main():
    parser = PrivateArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=ENVIRONMENTS, default="inherited-path")
    parser.add_argument("--host-claim", choices=HOSTS, default="none")
    arguments = parser.parse_args()
    print(json.dumps(observe_runtime(arguments.environment, arguments.host_claim), sort_keys=True))


if __name__ == "__main__":
    main()
