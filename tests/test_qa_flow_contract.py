from tests.support.contract_case import *


class ContractTests(ContractCase):
    def test_review_step_is_required(self):
        fixture = self.valid_fixture()
        fixture["steps"][2]["kind"] = "form"
        self.assert_contract_error(fixture, "review step is required")

    def test_enabled_tripwire_is_required(self):
        fixture = self.valid_fixture()
        fixture["steps"][2]["finalAction"]["tripwire"] = False
        self.assert_contract_error(
            fixture, "enabled final-action tripwire is required"
        )

    def test_final_action_boolean_types_are_strict(self):
        fixture = self.valid_fixture()
        fixture["steps"][2]["finalAction"]["enabled"] = 1
        self.assert_contract_error(
            fixture, "enabled final-action tripwire is required"
        )

    def test_next_target_must_exist(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["next"] = "missing"
        self.assert_contract_error(fixture, "next target does not exist")

    def test_fixture_flow_rejects_self_cycle(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["next"] = "step-1"
        self.assert_contract_error(fixture, "fixture flow contains a cycle")

    def test_fixture_flow_rejects_multi_node_cycle(self):
        fixture = self.valid_fixture()
        fixture["steps"][1]["next"] = "step-1"
        self.assert_contract_error(fixture, "fixture flow contains a cycle")

    def test_fixture_flow_rejects_unreachable_declared_step(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["next"] = "review"
        self.assert_contract_error(fixture, "fixture flow has unreachable steps")

    def test_fixture_flow_rejects_review_entry_with_trailing_forms(self):
        fixture = self.valid_fixture()
        fixture["steps"] = [
            fixture["steps"][2],
            fixture["steps"][0],
            fixture["steps"][1],
        ]
        self.assert_contract_error(fixture, "fixture flow has unreachable steps")

    def test_oracle_requires_zero_final_activations(self):
        fixture = self.valid_fixture()
        fixture["oracle"]["finalActionActivations"] = 1
        self.assert_contract_error(
            fixture, "oracle must require zero final-action activations"
        )

    def test_duplicate_step_ids_are_rejected(self):
        fixture = self.valid_fixture()
        fixture["steps"][1]["id"] = "step-1"
        self.assert_contract_error(fixture, "duplicate step id")
