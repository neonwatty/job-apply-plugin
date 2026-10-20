import unittest

from tests.support.policy_case import POLICY


class PolicySplitContractTests(unittest.TestCase):
    def test_facade_composes_directional_policy_modules(self):
        module_names = {base.__module__ for base in POLICY.PolicyStore.__bases__}
        for suffix in (".storage", ".campaigns", ".authorization", ".outcomes"):
            self.assertTrue(any(name.endswith(suffix) for name in module_names))

    def test_facade_retains_public_and_compatibility_exports(self):
        for name in (
            "PolicyStore",
            "PolicyError",
            "SCHEMA_VERSION",
            "CAMPAIGN_FIELDS",
            "OUTCOMES",
            "confirmation_authority_revision",
            "format_time",
            "parse_time",
            "build_parser",
            "run",
            "main",
        ):
            self.assertTrue(hasattr(POLICY, name), name)


if __name__ == "__main__":
    unittest.main()
