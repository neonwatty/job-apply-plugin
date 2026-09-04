import base64
import http.client
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[2]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


WORKSPACE = load_module("job_apply_workspace_test", ROOT / "scripts" / "job-apply-workspace.py")


class WorkspaceCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store_root = Path(self.temporary.name) / "store"
        self.server = WORKSPACE.WorkspaceServer(self.store_root, 0, token="test-workspace-token")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method, path, payload=None, *, token=True, origin=True, host=None, content_type="application/json", raw=None):
        connection = http.client.HTTPConnection(WORKSPACE.LOOPBACK, self.server.server_port, timeout=3)
        headers = {"Host": host or self.server.expected_host}
        if token:
            headers["Authorization"] = f"Bearer {self.server.token}"
        if origin:
            headers["Origin"] = self.server.origin
        body = raw
        if payload is not None:
            body = json.dumps(payload).encode()
        if body is not None:
            headers["Content-Type"] = content_type
            headers["Content-Length"] = str(len(body))
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        try:
            decoded = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            decoded = data
        return response.status, response.getheaders(), decoded

    def create_job(self, url="https://example.com/jobs/one", **fields):
        status, _headers, result = self.request("POST", "/api/jobs", {"job": {"url": url, **fields}})
        self.assertEqual(status, 200, result)
        return result

    def upload(self, filename, content, metadata):
        return {"metadata": metadata, "filename": filename, "content": base64.b64encode(content).decode("ascii")}
