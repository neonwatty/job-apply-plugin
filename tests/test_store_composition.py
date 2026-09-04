from __future__ import annotations

import ast
import importlib
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests.support.store_facade_contract import ROOT, load_module


ALIASES = (
    "_profile_domain", "_profile_facts_domain",
    "_answer_read_domain", "_answer_mutation_domain", "_answer_merge_domain",
    "_answer_cleanup_domain", "_job_crud_domain", "_job_overview_domain",
    "_job_upsert_domain", "_job_legacy_domain",
    "_coordinator_persistence_domain", "_coordinator_claims_domain",
    "_coordinator_attention_domain", "_coordinator_progress_domain",
    "_coordinator_approvals_domain", "_resumes_storage_domain",
    "_resumes_read_domain", "_resumes_mutations_domain",
    "_resumes_lifecycle_domain", "_extractions_journal_domain",
    "_extractions_requests_domain", "_extractions_proposals_domain",
    "_sessions_history_domain", "_sessions_readiness_domain",
    "_sessions_document_domain", "_sessions_lifecycle_domain",
    "_accounts_email_execution_domain", "_accounts_email_scope_domain",
    "_accounts_operations_domain", "_accounts_password_execution_domain",
    "_accounts_registry_domain", "_accounts_settings_domain",
    "_accounts_synthetic_domain", "_accounts_trusted_fill_domain",
    "_startup_domain",
)

MIXINS = (
    "ProfileStoreMixin", "ProfileFactsStoreMixin", "AnswerReadMixin",
    "AnswerMutationMixin", "AnswerMergeMixin", "AnswerCleanupMixin",
    "JobCrudMixin", "JobOverviewMixin", "JobUpsertMixin", "JobLegacyMixin",
    "CoordinatorPersistenceMixin", "CoordinatorClaimsMixin",
    "CoordinatorAttentionMixin", "CoordinatorProgressMixin",
    "CoordinatorApprovalsMixin", "ResumeStorageMixin", "ResumeReadMixin",
    "ResumeMutationMixin", "ResumeLifecycleMixin", "ExtractionJournalMixin",
    "ExtractionRequestMixin", "ExtractionProposalMixin", "SessionHistoryMixin",
    "SessionReadinessMixin", "SessionDocumentMixin", "SessionLifecycleMixin",
    "EmailExecutionMixin", "EmailScopeMixin", "AccountOperationMixin",
    "PasswordExecutionMixin", "AccountRegistryMixin", "AccountSettingsMixin",
    "SyntheticAccountMixin", "TrustedFillMixin", "StartupMixin",
)

BOUND = (
    "_accounts_email_execution_domain", "_accounts_email_scope_domain",
    "_accounts_operations_domain", "_accounts_password_execution_domain",
    "_accounts_registry_domain", "_accounts_settings_domain",
    "_accounts_synthetic_domain", "_accounts_trusted_fill_domain",
    "_sessions_history_domain", "_sessions_readiness_domain",
    "_sessions_document_domain", "_sessions_lifecycle_domain",
    "_resumes_storage_domain", "_resumes_read_domain",
    "_resumes_mutations_domain", "_resumes_lifecycle_domain",
    "_extractions_journal_domain", "_extractions_requests_domain",
    "_extractions_proposals_domain", "_answer_read_domain",
    "_answer_mutation_domain", "_answer_merge_domain", "_answer_cleanup_domain",
    "_job_upsert_domain", "_job_legacy_domain",
    "_coordinator_persistence_domain", "_coordinator_claims_domain",
    "_coordinator_attention_domain", "_coordinator_progress_domain",
    "_coordinator_approvals_domain", "_startup_domain",
)


class StoreCompositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_composition_contract")
        cls.composition = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.composition"
        )

    def test_frozen_alias_mixin_and_binding_order(self):
        self.assertEqual(
            tuple(item[0] for item in self.composition._DOMAIN_IMPORTS), ALIASES
        )
        self.assertEqual(
            tuple(item[2] for item in self.composition._DOMAIN_IMPORTS), MIXINS
        )
        self.assertEqual(self.composition._RUNTIME_BINDING_ORDER, BOUND)
        domains, mixins = self.composition.load_domains(
            self.facade._PACKAGE_NAME, lambda: vars(self.facade)
        )
        self.assertEqual(tuple(domains), ALIASES)
        self.assertEqual(tuple(mixin.__name__ for mixin in mixins), MIXINS)
        self.assertEqual(mixins[-1].__name__, "StartupMixin")
        self.assertNotIn(self.facade._base.StoreBase, mixins)

    def test_imports_precede_exact_runtime_binding_sequence(self):
        events = []
        modules = {}
        for alias, module_name, mixin_name in self.composition._DOMAIN_IMPORTS:
            mixin = type(mixin_name, (), {})
            module = SimpleNamespace(**{mixin_name: mixin})
            if alias in BOUND:
                module._bind_runtime = (
                    lambda provider, name=alias: events.append(("bind", name, provider))
                )
            modules[module_name] = module

        def importing(name):
            module_name = name.removeprefix("frozen_package.")
            events.append(("import", module_name))
            return modules[module_name]

        provider = lambda: {"sentinel": True}
        with mock.patch.object(
            self.composition.importlib, "import_module", side_effect=importing
        ):
            domains, mixins = self.composition.load_domains(
                "frozen_package", provider
            )
        self.assertEqual(
            events[:len(ALIASES)],
            [("import", item[1]) for item in self.composition._DOMAIN_IMPORTS],
        )
        self.assertEqual(
            events[len(ALIASES):],
            [("bind", alias, provider) for alias in BOUND],
        )
        self.assertEqual(tuple(domains), ALIASES)
        self.assertEqual(tuple(item.__name__ for item in mixins), MIXINS)

    def test_repeated_and_two_root_loads_remain_root_local(self):
        with tempfile.TemporaryDirectory() as temporary:
            roots = []
            for name in ("plugin-a", "plugin-b"):
                root = Path(temporary) / name
                shutil.copytree(
                    ROOT,
                    root,
                    ignore=shutil.ignore_patterns(
                        ".git", ".worktrees", "node_modules", "__pycache__"
                    ),
                )
                roots.append(root)
            facades = [
                load_module(root / "scripts" / "job-apply-store.py", f"composition_{index}")
                for index, root in enumerate(roots)
            ]
            loaded = []
            for facade, root in zip(facades, roots):
                composition = importlib.import_module(
                    f"{facade._PACKAGE_NAME}.composition"
                )
                first_provider = lambda module=facade: vars(module)
                domains, mixins = composition.load_domains(
                    facade._PACKAGE_NAME, first_provider
                )
                self.assertTrue(all(
                    Path(module.__file__).resolve().is_relative_to(root.resolve())
                    for module in domains.values()
                ))
                second_provider = lambda: {"second": True}
                again, again_mixins = composition.load_domains(
                    facade._PACKAGE_NAME, second_provider
                )
                self.assertTrue(all(
                    again[alias] is domains[alias] for alias in ALIASES
                ))
                self.assertEqual(again_mixins, mixins)
                self.assertTrue(all(
                    again[alias]._RUNTIME_PROVIDER is second_provider
                    for alias in BOUND
                ))
                loaded.append(domains)
            self.assertTrue(all(
                loaded[0][alias] is not loaded[1][alias] for alias in ALIASES
            ))

    def test_canonical_primitives_do_not_import_composition(self):
        package = ROOT / "scripts" / "job_apply_store"
        primitives = [
            package / name
            for name in (
                "__init__.py", "accounts_runtime.py", "base.py", "constants.py",
                "errors.py", "io.py", "normalization.py", "sessions_runtime.py",
            )
        ] + sorted((package / "validation").glob("*.py"))
        for path in primitives:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            imports = [
                node.module or ""
                for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom)
            ] + [
                alias.name
                for node in ast.walk(tree)
                if isinstance(node, ast.Import)
                for alias in node.names
            ]
            self.assertFalse(
                any(name == "composition" or name.endswith(".composition") for name in imports),
                path,
            )


if __name__ == "__main__":
    unittest.main()
