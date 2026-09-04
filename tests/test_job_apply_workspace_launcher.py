from tests.support.workspace_case import *


class WorkspaceProcessTests(unittest.TestCase):
    def test_launcher_reports_fragment_token_and_stops_cleanly(self):
        with tempfile.TemporaryDirectory() as temporary:
            process = subprocess.Popen(
                [sys.executable, str(ROOT / "scripts" / "job-apply-workspace.py"), "--root", str(Path(temporary) / "store"), "--port", "0", "--no-open", "--json"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
            )
            try:
                line = process.stdout.readline()
                details = json.loads(line)
                self.assertEqual(details["host"], "127.0.0.1")
                self.assertIn("/#token=", details["url"])
                connection = http.client.HTTPConnection("127.0.0.1", details["port"], timeout=3)
                connection.request("GET", "/", headers={"Host": f"127.0.0.1:{details['port']}"})
                self.assertEqual(connection.getresponse().status, 200)
                connection.close()
                if os.name == "nt":
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    process.send_signal(signal.SIGINT)
                self.assertEqual(process.wait(timeout=5), 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)

    def test_launcher_uses_canonical_store_environment_variable(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            store = Path(temporary) / "configured-store"
            home.mkdir()
            environment = os.environ.copy()
            environment["HOME"] = str(home)
            environment[WORKSPACE.STORE_MODULE.STORE_ENV] = str(store)
            environment.pop("JOB_APPLY_STORE", None)
            process = subprocess.Popen(
                [sys.executable, str(ROOT / "scripts" / "job-apply-workspace.py"), "--port", "0", "--no-open", "--json"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment,
                creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
            )
            try:
                details = json.loads(process.stdout.readline())
                self.assertEqual(details["host"], "127.0.0.1")
                self.assertTrue((store / "jobs.json").is_file())
                self.assertFalse((home / ".job-apply").exists())
                if os.name == "nt":
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    process.send_signal(signal.SIGINT)
                self.assertEqual(process.wait(timeout=5), 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
