"""Real distribution separation, restart, and upgrade regressions."""
import http.client
import importlib.util
import json
import os
import queue
import threading
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class CompanionInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        for name in ('companion', 'scripts', 'native', 'qa'):
            shutil.copytree(ROOT / name, self.source / name,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        self.installer = module('isolated_companion_installer', self.source / 'companion/install.py')
        self.prefix = self.root / 'stable-ui'
        self.store = self.root / 'applicant-store'

    def command(self, *args, **kwargs):
        return subprocess.run([sys.executable, *map(str, args)], capture_output=True,
                              text=True, timeout=30, **kwargs)

    def start(self, launcher=None):
        process = subprocess.Popen([sys.executable, str(launcher or self.prefix / 'companion.py'),
                                    '--root', str(self.store), '--no-open', '--json'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   env={**os.environ, 'JOB_APPLY_COMPANION_HOME': str(self.prefix)})
        def cleanup():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            process.stdout.close()
            process.stderr.close()
        self.addCleanup(cleanup)
        output = queue.Queue()
        reader = threading.Thread(target=lambda: output.put(process.stdout.readline()), daemon=True)
        reader.start()
        try:
            line = output.get(timeout=15)
        except queue.Empty:
            self.fail('companion did not report startup within 15 seconds')
        self.assertTrue(line, 'companion exited without startup details')
        self.assertIsNone(process.poll(), 'attached launcher exited while the server was starting')
        return process, json.loads(line)

    def request(self, details, path):
        conn = http.client.HTTPConnection('127.0.0.1', details['port'], timeout=5)
        token = details['url'].split('#token=')[1]
        conn.request('GET', path, headers={'Authorization': 'Bearer ' + token})
        response = conn.getresponse()
        data = response.read()
        conn.close()
        self.assertEqual(response.status, 200)
        return data

    def test_ui_survives_source_removal_upgrade_and_restart_with_shared_cli(self):
        first = self.installer.install(self.prefix)
        process, details = self.start()
        self.assertEqual(details['companionVersion'], '1.3.5')
        self.assertIn(b'Jobs Workspace', self.request(details, '/'))
        # Agent-only package has no companion server/assets.
        plugin = self.root / 'plugin'
        built = self.command(ROOT / 'scripts/build-plugin.py', '--output', plugin)
        self.assertEqual(built.returncode, 0, built.stderr)
        self.assertFalse((plugin / 'companion').exists())
        self.assertFalse((plugin / 'workspace').exists())
        self.assertFalse((plugin / 'scripts/job_apply_workspace').exists())
        created = self.command(plugin / 'scripts/job-apply-store.py', '--root', self.store,
                               'job-create', '--input', '-', input=json.dumps({'url': 'https://example.invalid/separation'}))
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertEqual(len(json.loads(self.request(details, '/api/state'))['jobs']), 1)
        version = self.source / 'companion/version.json'
        value = json.loads(version.read_text()); value['version'] = '1.3.6'
        version.write_text(json.dumps(value))
        second = self.installer.install(self.prefix)
        self.assertNotEqual(first['release'], second['release'])
        shutil.rmtree(plugin)
        shutil.rmtree(self.source)
        self.assertIn(b'Jobs Workspace', self.request(details, '/'))
        process.terminate(); process.wait(timeout=10)
        _, restarted = self.start()
        self.assertEqual(restarted['companionVersion'], '1.3.6')
        self.assertEqual(len(json.loads(self.request(restarted, '/api/state'))['jobs']), 1)
        status = self.command(self.prefix / 'companion.py', '--status', '--root', self.store)
        self.assertEqual(json.loads(status.stdout)['version'], '1.3.6')
        self.assertNotIn('token', status.stdout)

    def test_plugin_discovery_keeps_server_attached_and_stops_it(self):
        self.installer.install(self.prefix)
        process, details = self.start(ROOT / 'scripts/job-apply-workspace.py')
        self.assertIn(b'Jobs Workspace', self.request(details, '/'))
        self.assertIsNone(process.poll())
        process.terminate()
        process.wait(timeout=10)
        connection = http.client.HTTPConnection('127.0.0.1', details['port'], timeout=2)
        try:
            with self.assertRaises(OSError):
                connection.request('GET', '/')
                connection.getresponse()
        finally:
            connection.close()

    def test_incompatible_or_damaged_installation_fails_before_store_creation(self):
        receipt = self.installer.install(self.prefix)
        bundle = self.prefix / 'versions' / receipt['release']
        metadata = bundle / 'bundle.json'
        original = metadata.read_text()
        data = json.loads(original); data['coreApi'] = 999
        metadata.write_text(json.dumps(data))
        failed = self.command(self.prefix / 'companion.py', '--root', self.store, '--no-open')
        self.assertEqual(failed.returncode, 2)
        self.assertFalse(self.store.exists())
        metadata.write_text(original)
        (bundle / 'workspace/app.js').write_text('broken')
        failed = self.command(self.prefix / 'companion.py', '--root', self.store, '--no-open')
        self.assertEqual(failed.returncode, 2)
        self.assertFalse(self.store.exists())

    def test_installer_rejects_recursive_source_destination(self):
        with self.assertRaisesRegex(ValueError, 'outside the source checkout'):
            self.installer.install(self.source / 'companion' / 'installed')
        self.assertFalse((self.source / 'companion' / 'installed').exists())

    def test_optional_plugin_launcher_does_not_install_ui_or_create_store(self):
        env = {**os.environ, 'JOB_APPLY_COMPANION_HOME': str(self.root / 'missing-ui')}
        result = self.command(ROOT / 'scripts/job-apply-workspace.py', '--root', self.store, env=env)
        self.assertEqual(result.returncode, 2)
        self.assertIn('optional companion', result.stderr)
        self.assertFalse(self.store.exists())
        self.assertFalse((self.root / 'missing-ui').exists())


if __name__ == '__main__':
    unittest.main()
