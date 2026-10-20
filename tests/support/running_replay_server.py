from tests.support.oracle_fixtures import *


class RunningServer:
    shutdown_token = "a" * 64

    def __init__(self, auto_submit=False):
        self.auto_submit = auto_submit

    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory()
        self.fixture_path = Path(self.directory.name) / "fixture.json"
        self.fixture_path.write_text(json.dumps(valid_fixture()))
        self.process = None
        try:
            self.process = subprocess.Popen(
                [
                    "python3",
                    "-m",
                    "qa.server",
                    "--fixture",
                    str(self.fixture_path),
                    "--port",
                    "0",
                    "--expected-resume-filename",
                    "synthetic-resume.pdf",
                    "--shutdown-token",
                    self.shutdown_token,
                    *(
                        ["--auto-submit-policy-root", str(Path(self.directory.name) / "policy")]
                        if self.auto_submit
                        else []
                    ),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            startup_lines = queue.Queue()
            reader = threading.Thread(
                target=lambda: startup_lines.put(self.process.stdout.readline()),
                daemon=True,
            )
            reader.start()
            try:
                line = startup_lines.get(timeout=5)
            except queue.Empty:
                raise AssertionError("server startup timed out") from None
            if not line:
                raise AssertionError("server exited before startup")
            self.startup = json.loads(line)
            self.port = self.startup["port"]
            if self.auto_submit:
                self.policy_store = PolicyStore(Path(self.directory.name) / "policy")
                self.application_ref = "application:" + "1" * 64
                base_url = f"http://127.0.0.1:{self.port}"
                revision = lambda label: "sha256:" + hashlib.sha256(label.encode()).hexdigest()
                self.authorization = {
                    "applicationRef": self.application_ref,
                    "origin": base_url,
                    "urlFingerprint": revision("synthetic-url"),
                    "ats": "linkedin",
                    "jobFingerprint": revision("synthetic-job"),
                    "formRevision": revision("synthetic-form"),
                    "finalControlRevision": revision("synthetic-control"),
                    "resumeRevision": revision("synthetic-resume"),
                    "answerRevisions": [],
                }
                rule = {key: self.authorization[key] for key in {
                    "applicationRef", "origin", "urlFingerprint", "ats",
                    "jobFingerprint", "formRevision", "finalControlRevision",
                }}
                self.policy_store.activate({
                    "riskAcknowledged": True,
                    "applicationRules": [rule],
                    "resumeRevision": self.authorization["resumeRevision"],
                    "sensitiveAllowlist": [],
                    "confirmationAuthorityRevision": confirmation_authority_revision(
                        self.shutdown_token
                    ),
                    "maxApplications": 1,
                    "durationSeconds": 300,
                })
                self.lease = self.policy_store.authorize(self.authorization)
            return self
        except BaseException:
            self._cleanup()
            raise

    def __exit__(self, *_):
        self._cleanup()

    def _cleanup(self):
        try:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        finally:
            if self.process is not None:
                if self.process.stdout is not None:
                    self.process.stdout.close()
                if self.process.stderr is not None:
                    self.process.stderr.close()
            self.directory.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = None if payload is None else json.dumps(payload).encode()
        request_headers = dict(headers or {})
        if payload is not None:
            request_headers.setdefault("Content-Type", "application/json")
        if method == "POST":
            request_headers.setdefault(
                "Origin", f"http://127.0.0.1:{self.port}"
            )
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (
            json.loads(raw.decode())
            if raw
            and response.getheader("Content-Type", "").startswith("application/json")
            else raw
        )
        headers_result = dict(response.getheaders())
        connection.close()
        return response.status, headers_result, result

    def raw_request(self, method, path, body=b"", headers=None, skip_host=False):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.putrequest(method, path, skip_host=skip_host)
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        connection.endheaders(body)
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        return response.status, raw
