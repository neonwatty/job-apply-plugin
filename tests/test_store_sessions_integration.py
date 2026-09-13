"""Production session composition and root-local patch ownership."""

import inspect
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.support.store_facade_contract import load_module
from tests.test_store_loader_isolation import copy_plugin


DOMAINS = (
    ("history", "SessionHistoryMixin", 3),
    ("readiness", "SessionReadinessMixin", 3),
    ("document", "SessionDocumentMixin", 3),
    ("lifecycle", "SessionLifecycleMixin", 6),
)


class SessionIntegrationTests(unittest.TestCase):
    def test_production_owns_each_extracted_method_once(self):
        facade = load_module(name="session_integrated")
        count = 0
        for domain, name, expected in DOMAINS:
            mixin = getattr(getattr(facade, "_sessions_" + domain + "_domain"), name)
            self.assertEqual(facade.Store.__mro__.count(mixin), 1)
            methods = [key for key, value in vars(mixin).items()
                       if inspect.isfunction(value) or isinstance(value, staticmethod)]
            self.assertEqual(len(methods), expected)
            count += len(methods)
            for method in methods:
                owners = [owner for owner in facade.Store.__mro__ if method in vars(owner)]
                self.assertEqual(owners, [mixin])
                self.assertIs(inspect.getattr_static(facade.Store, method),
                              inspect.getattr_static(mixin, method))
        self.assertEqual(count, 15)

    def test_reload_keeps_other_root_runtime_patches_and_session_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            roots = [copy_plugin(root / name) for name in ("a", "b")]
            first, other = [load_module(path / "scripts/job-apply-store.py", name)
                            for path, name in zip(roots, ("session_first", "session_other"))]
            store = other.Store(root / "store")
            store.save_session("app", {"status": "active"})
            before = (store.sessions_path / "app.json").read_bytes()
            fresh = load_module(roots[0] / "scripts/job-apply-store.py", "session_fresh")
            self.assertIsNot(first._sessions_document_domain, fresh._sessions_document_domain)
            with mock.patch.object(other, "atomic_write_json", side_effect=OSError("interrupted")):
                with self.assertRaisesRegex(OSError, "interrupted"):
                    store.save_session("app", {"status": "review"})
                fresh.Store(root / "fresh-store").save_session("fresh", {"status": "active"})
            self.assertEqual((store.sessions_path / "app.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
