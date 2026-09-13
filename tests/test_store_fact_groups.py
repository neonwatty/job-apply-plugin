from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_fact_groups_are_revisioned_saved_views_and_never_own_profile_facts(self):
        self.store.initialize()
        profile = self.store.replace_profile(
            {"firstName": "Synthetic", "skills": ["Python"]}, 1, "user"
        )
        created = self.store.create_fact_group({
            "label": "Interview essentials",
            "paths": ["/firstName", "/skills"],
        })
        self.assertRegex(created["id"], r"^[a-f0-9]{32}$")
        self.assertEqual(created["revision"], 1)
        self.assertEqual(self.store.list_fact_groups(), [created])

        updated = self.store.update_fact_group(
            created["id"],
            {"label": "Core application", "paths": ["/firstName"], "order": 25},
            created["revision"],
        )
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["order"], 25)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_fact_group(
                created["id"], {"label": "Stale"}, created["revision"]
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "label already exists"):
            self.store.create_fact_group({
                "label": "core APPLICATION",
                "paths": ["/skills"],
            })
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "path is invalid"):
            self.store.create_fact_group({
                "label": "Invalid pointer",
                "paths": ["not-a-pointer"],
            })

        deleted = self.store.delete_fact_group(updated["id"], updated["revision"])
        self.assertEqual(deleted, {"deleted": True, "id": updated["id"]})
        self.assertEqual(self.store.list_fact_groups(), [])
        self.assertEqual(self.store.inspect_profile(), profile)
