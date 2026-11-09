"""Enumerated synthetic CLI inputs; never loaded from caller-provided files."""

GROUP_ID = "00000000000000000000000000000001"
CANARY = "PROFILE_FACT_SECRET_CANARY_7c923d"


def patch(value, revision=1, source="user"):
    return (["profile-patch", "--input", "-", "--expected-revision", str(revision),
             "--source", source], value)


def create(value):
    return (["fact-group-create", "--input", "-"], value)


def update(value, revision=1):
    return (["fact-group-update", "--id", GROUP_ID, "--input", "-",
             "--expected-revision", str(revision)], value)


def delete(revision=1):
    return (["fact-group-delete", "--id", GROUP_ID,
             "--expected-revision", str(revision)], None)


PROFILE = patch({"identity": {"name": "Synthetic Person", "city": "Example"}})
GROUP = create({"label": " Identity ", "paths": ["/identity/name", "/identity/city"]})

# name, setup commands, command/input, exact write set, exit status
SCENARIOS = [
    ("profile-merge", [], PROFILE, ["profile.json"], 0),
    ("profile-nested-delete", [PROFILE], patch({"identity": {"city": None}}, 2), ["profile.json"], 0),
    ("profile-pointer-escaping", [], patch({"a/b~c": "Synthetic"}), ["profile.json"], 0),
    ("profile-noop", [PROFILE], patch(PROFILE[1], 2), [], 0),
    ("profile-revision-conflict", [PROFILE], patch({"identity": {"name": CANARY}}), [], 2),
    ("profile-provenance-conflict", [PROFILE], patch({"identity": {"name": CANARY}}, 2, "agent"), [], 2),
    ("profile-empty-input", [], patch({}), [], 2),
    ("profile-nonobject-input", [], patch([CANARY]), [], 2),
    ("group-create", [], GROUP, ["fact-groups.json"], 0),
    ("group-update", [GROUP], update({"label": "Contact", "paths": ["/identity/name"], "order": 10}), ["fact-groups.json"], 0),
    ("group-noop", [GROUP], update({"label": "Identity"}), [], 0),
    ("group-update-conflict", [GROUP], update({"label": CANARY}, 9), [], 2),
    ("group-delete", [GROUP], delete(), ["fact-groups.json"], 0),
    ("group-delete-conflict", [GROUP], delete(9), [], 2),
    ("group-delete-missing", [], delete(), [], 2),
    ("group-duplicate-label", [GROUP], create({"label": "IDENTITY", "paths": ["/other"]}), [], 2),
    ("group-invalid-pointer", [], create({"label": "Synthetic", "paths": [CANARY]}), [], 2),
    ("group-invalid-order", [GROUP], update({"order": True}), [], 2),
    ("group-unknown-field", [], create({"label": "Synthetic", "paths": ["/x"], "secret": CANARY}), [], 2),
]
