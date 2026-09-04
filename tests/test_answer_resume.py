from tests.support.answer_cli_case import *


class AnswerMemoryIntegrationTests(AnswerCliCase):
    def test_resume_proposal_cli_autofills_and_reviews_conflicts(self):
        self.json_store("init")
        profile_input = self.write_input("proposal-profile.json", {"firstName": "Human"})
        profile = self.json_store(
            "profile-replace",
            "--input",
            str(profile_input),
            "--expected-revision",
            "1",
            "--source",
            "user",
        )
        resume_path = self.home / "proposal-resume.txt"
        resume_path.write_text("synthetic proposal resume", encoding="utf-8")
        resume_input = self.write_input(
            "proposal-resume.json",
            {"id": "proposal-cli", "label": "Proposal CLI", "path": str(resume_path)},
        )
        resume = self.json_store("resume-import", "--input", str(resume_input))
        candidate_input = self.write_input(
            "proposal-candidate.json",
            {"firstName": "Extracted", "email": "synthetic@example.invalid"},
        )
        proposal = self.json_store(
            "resume-proposal-create",
            "--resume-id",
            resume["id"],
            "--expected-resume-revision",
            str(resume["revision"]),
            "--expected-profile-revision",
            str(profile["revision"]),
            "--input",
            str(candidate_input),
        )
        self.assertEqual(proposal["autoFilledPaths"], ["/email"])
        self.assertEqual(proposal["pendingPaths"], ["/firstName"])
        self.assertEqual(
            self.json_store("resume-proposal-get", "--id", proposal["id"])["id"],
            proposal["id"],
        )
        self.assertEqual(len(self.json_store("resume-proposal-list")), 1)
        review_input = self.write_input(
            "proposal-review.json", {"decisions": {"/firstName": "use_extracted"}}
        )
        reviewed = self.json_store(
            "resume-proposal-review",
            "--id",
            proposal["id"],
            "--expected-revision",
            str(proposal["revision"]),
            "--expected-profile-revision",
            str(proposal["resultProfileRevision"]),
            "--input",
            str(review_input),
        )
        self.assertEqual(reviewed["status"], "completed")
        final_profile = self.json_store("profile-inspect")
        self.assertEqual(final_profile["profile"]["firstName"], "Extracted")
        self.assertEqual(final_profile["factProvenance"]["/firstName"]["source"], "user")

    def test_resume_proposal_cli_summary_list_omits_private_values(self):
        self.json_store("init")
        profile_input = self.write_input(
            "summary-profile.json", {"firstName": "Private Baseline"}
        )
        profile = self.json_store(
            "profile-replace", "--input", str(profile_input),
            "--expected-revision", "1", "--source", "user",
        )
        source = self.home / "summary-resume.txt"
        source.write_text("private resume bytes", encoding="utf-8")
        resume_input = self.write_input(
            "summary-resume.json", {"label": "Private Resume", "path": str(source)}
        )
        resume = self.json_store("resume-import", "--input", str(resume_input))
        candidate_input = self.write_input(
            "summary-candidate.json",
            {"firstName": "Private Candidate", "email": "private@example.invalid"},
        )
        proposal = self.json_store(
            "resume-proposal-create", "--resume-id", resume["id"],
            "--expected-resume-revision", str(resume["revision"]),
            "--expected-profile-revision", str(profile["revision"]),
            "--input", str(candidate_input),
        )

        listed = self.json_store("resume-proposal-list", "--summary-only")

        self.assertEqual(listed, [{
            "id": proposal["id"],
            "resumeId": resume["id"],
            "status": "pending",
            "revision": 1,
            "autoFilledCount": 1,
            "pendingCount": 1,
        }])
        serialized = json.dumps(listed, sort_keys=True)
        for forbidden in (
            "Private Baseline", "Private Candidate", "private@example.invalid",
            "private resume bytes", "candidate", "baselines",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_resume_extraction_request_cli_is_value_free(self):
        self.json_store("init")
        source = self.home / "private-request.txt"
        source.write_text("private resume text", encoding="utf-8")
        resume_input = self.write_input("private-request.json", {
            "id": "request-cli", "label": "Private Resume", "path": str(source)
        })
        resume = self.json_store("resume-import", "--input", str(resume_input))
        request = self.json_store(
            "resume-extraction-request-create", "--resume-id", resume["id"],
            "--expected-resume-revision", str(resume["revision"]),
        )
        listed = self.json_store("resume-extraction-request-list")
        fetched = self.json_store(
            "resume-extraction-request-get", "--id", request["requestId"]
        )
        serialized = json.dumps({"request": request, "listed": listed, "fetched": fetched})
        for forbidden in (source.name, str(source), resume["digest"], "private resume text", "Private Resume"):
            self.assertNotIn(forbidden, serialized)
        failed = self.json_store(
            "resume-extraction-request-fail", "--id", request["requestId"],
            "--reason", "interrupted", "--expected-revision", str(request["revision"]),
        )
        retried = self.json_store(
            "resume-extraction-request-retry", "--id", request["requestId"],
            "--expected-revision", str(failed["revision"]),
            "--expected-resume-revision", str(resume["revision"]),
        )
        requests_path = self.home / ".job-apply" / "resume-extraction-requests.json"
        requests_document = json.loads(requests_path.read_text(encoding="utf-8"))
        predecessor = requests_document["requests"].pop(failed["requestId"])
        successor = requests_document["requests"].pop(retried["requestId"])
        predecessor.update({
            "requestId": "request-zzzz", "createdAt": "2026-09-03T12:00:00Z",
            "updatedAt": "2026-09-03T12:00:00Z", "closedAt": "2026-09-03T12:00:00Z",
        })
        successor.update({
            "requestId": "request-aaaa", "supersedesRequestId": "request-zzzz",
            "createdAt": "2026-09-03T12:00:00Z", "updatedAt": "2026-09-03T12:00:00Z",
        })
        requests_document["requests"] = {
            predecessor["requestId"]: predecessor, successor["requestId"]: successor,
        }
        requests_path.write_text(json.dumps(requests_document), encoding="utf-8")
        same_second = self.json_store(
            "resume-extraction-request-list", "--resume-id", resume["id"]
        )
        self.assertEqual(
            [item["requestId"] for item in same_second],
            [predecessor["requestId"], successor["requestId"]],
        )
        retried = successor
        candidate = self.write_input("candidate.json", {
            "email": "candidate-private@example.invalid"
        })
        completed = self.json_store(
            "resume-extraction-request-complete", "--id", retried["requestId"],
            "--input", str(candidate), "--expected-request-revision",
            str(retried["revision"]), "--expected-profile-revision", "1",
        )
        self.assertNotIn("candidate-private@example.invalid", json.dumps(completed))

    def test_profile_preparedness_cli_matches_store(self):
        self.json_store("init")
        source = self.home / "preparedness-cli-private.txt"
        source.write_text("preparedness cli private bytes", encoding="utf-8")
        resume_input = self.write_input("preparedness-resume.json", {
            "id": "preparedness-cli", "label": "Preparedness Private Label",
            "path": str(source),
        })
        resume = self.json_store("resume-import", "--input", str(resume_input))
        profile_input = self.write_input("preparedness-profile.json", {
            "firstName": "Private First", "lastName": "Private Last",
            "email": "private-cli@example.invalid", "skills": ["Private Skill"],
        })
        self.json_store(
            "profile-replace", "--input", str(profile_input),
            "--expected-revision", "1", "--source", "user",
        )
        request = self.json_store(
            "resume-extraction-request-create", "--resume-id", resume["id"],
            "--expected-resume-revision", str(resume["revision"]),
        )
        projection = self.json_store("profile-preparedness-get")
        self.assertEqual(
            set(projection), {"essentialSetup", "commonCoverage", "reviewHealth"}
        )
        self.assertEqual(projection["reviewHealth"][0]["requestId"], request["requestId"])
        serialized = json.dumps(projection, sort_keys=True).lower()
        for forbidden in (
            "score", "percent", "employability", "job_ready", "private first",
            "private last", "private-cli@example.invalid", "private skill",
            source.name.lower(), str(source).lower(), resume["digest"],
            "preparedness cli private bytes", "preparedness private label",
        ):
            self.assertNotIn(forbidden, serialized)
