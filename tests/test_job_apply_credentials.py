import importlib.util
import inspect
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("credentials_test", ROOT / "scripts" / "job_apply_credentials.py")
CREDENTIALS = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(CREDENTIALS)
MAC_SPEC = importlib.util.spec_from_file_location("credentials_macos_test", ROOT / "scripts" / "job_apply_credentials_macos.py")
MAC = importlib.util.module_from_spec(MAC_SPEC); MAC_SPEC.loader.exec_module(MAC)


class CredentialProviderTests(unittest.TestCase):
    def test_unique_shared_and_human_strategies_are_closed(self):
        first = "a" * 64; second = "b" * 64
        self.assertNotEqual(
            MAC.MacOSSecurityFrameworkProvider.credential_reference("unique_per_realm", first),
            MAC.MacOSSecurityFrameworkProvider.credential_reference("unique_per_realm", second),
        )
        self.assertEqual(
            MAC.MacOSSecurityFrameworkProvider.credential_reference("shared", first),
            MAC.MacOSSecurityFrameworkProvider.credential_reference("shared", second),
        )
        for strategy in ("custom", "ask_each_time"):
            with self.assertRaises(MAC.PORTABLE.CredentialProviderError):
                MAC.MacOSSecurityFrameworkProvider.credential_reference(strategy, first)

    def test_provider_contract_has_only_compound_write_operation(self):
        public = {name for name, _ in inspect.getmembers(CREDENTIALS.CredentialProvider, inspect.isfunction) if not name.startswith("_")}
        self.assertEqual(public, {"provision_or_reuse_and_fill"})
        provider = CREDENTIALS.synthetic_provider_for_tests(CREDENTIALS.synthetic_test_authority())
        request = {"realmRef": "a" * 64, "strategy": "unique_per_realm", "existingCredentialRef": None, "secureControlFingerprint": "sha256:" + "1" * 64, "syntheticTargetUrl": "http://127.0.0.1:1/synthetic-account/success", "operationFingerprint": "sha256:" + "2" * 64}
        first = provider.provision_or_reuse_and_fill(request)
        second = provider.provision_or_reuse_and_fill({**request, "existingCredentialRef": first["credentialRef"]})
        self.assertFalse(first["reused"]); self.assertTrue(second["reused"])
        self.assertNotIn("secret", repr(first).lower())

    def test_provider_identity_and_reference_are_adapter_owned(self):
        self.assertFalse(hasattr(CREDENTIALS, "PROVIDER_ID"))
        self.assertTrue(callable(CREDENTIALS.credential_reference))
        self.assertFalse(hasattr(CREDENTIALS, "MacOSSecurityFrameworkProvider"))
        self.assertEqual(MAC.MacOSSecurityFrameworkProvider.provider_id, "macos-keychain")
        self.assertEqual(provider.provider_id if (provider := CREDENTIALS.synthetic_provider_for_tests(CREDENTIALS.synthetic_test_authority())) else None, "synthetic-protected")

    def test_capability_is_side_effect_free_and_never_live_ready(self):
        provider = MAC.MacOSSecurityFrameworkProvider()
        mac = provider.capability("darwin")
        self.assertEqual((mac["state"], mac["syntheticOperationsReady"], mac["credentialOperationsReady"]), ("available", True, False))
        self.assertEqual(provider.capability("linux")["state"], "unsupported")
        with self.assertRaises(MAC.PORTABLE.CredentialProviderError):
            provider.provision_or_reuse_and_fill({})
