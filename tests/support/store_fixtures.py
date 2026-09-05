import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def review_session(store_module, attempt_revision, step, fixture_id):
    fixture = json.loads((
        ROOT / "qa" / "fixtures" / fixture_id / "fixture.json"
    ).read_text(encoding="utf-8"))
    control_states = {
        control["id"]: "accepted" if control["role"] == "file" else "complete"
        for fixture_step in fixture["steps"]
        for control in fixture_step["controls"]
        if control["required"]
    }
    observation = store_module.FORM_READINESS_MODULE.make_readiness_observation(
        fixture,
        control_states,
        observation_revision=11,
    )
    return {
        "status": "review", "step": step, "pendingFields": [],
        "attemptRevision": attempt_revision,
        "readinessInput": {
            "attemptRevision": attempt_revision,
            "evidenceKind": "agent_attested_current_attempt",
            "fixture": fixture,
            "formManifest": store_module.FORM_READINESS_MODULE.make_form_manifest(
                fixture, observation_revision=11
            ),
            "observation": observation,
            "expectedObservationRevision": 11,
        },
    }


def legacy_1_2_session(application_id, pending_fields):
    return {
        "schemaVersion": 1,
        "applicationId": application_id,
        "status": "active",
        "step": "questions",
        "answerKeys": ["answer.work_authorization"],
        "pendingFields": pending_fields if pending_fields is not None else [
            {
                "question": "Are you authorized to work in the United States?",
                "state": "missing",
                "answerKey": "answer.work_authorization",
                "sensitive": True,
            },
            {
                "question": "Will you require sponsorship?",
                "state": "inferred",
                "answerKey": "answer.sponsorship",
                "sensitive": False,
            },
        ],
        "createdAt": "2026-08-01T00:00:00Z",
        "updatedAt": "2026-08-01T00:01:00Z",
    }
