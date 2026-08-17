from __future__ import annotations

import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tempfile
import stat
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
import time
from urllib.parse import parse_qs, urlsplit
from unittest import mock
import zlib

from qa.compiler import compile_capture
from qa.contracts import LEVER_CONTROL_PROFILE, generic_control


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "qa-replay.py"
PRIVATE_CAPTURE = ROOT / "qa" / "testdata" / "private-capture"
FIXTURE_ID = "linkedin-easy-apply-short-2026-08-v1"
SCENARIO_ID = "complete-profile"
SYNTHETIC_RESUME_SHA256 = (
    "04eab9c3265232cf4950631ca2c8a1e1b3070da6d441ebb8953221ced8c55274"
)
PROMPT = (
    "Use job-apply:job-apply on this approved local LinkedIn Easy Apply QA "
    "fixture: {url}. Use the isolated QA profile already prepared for this "
    "run. Operate the visible form normally and stop at final review exactly "
    "as you would on a live application."
)


def append_to_pdf_content(content: bytes, addition: bytes) -> bytes:
    header = re.search(rb"<<(.*?)>>\s*stream\r?\n", content, re.DOTALL)
    if header is None:
        raise AssertionError("test PDF has no content stream")
    length_match = re.search(rb"/Length\s+([0-9]+)\b", header.group(1))
    if length_match is None:
        raise AssertionError("test PDF has no direct stream length")
    old_length = int(length_match.group(1))
    old_stream = content[header.end() : header.end() + old_length]
    new_stream = zlib.compress(zlib.decompress(old_stream) + b"\n" + addition)
    dictionary = header.group(0)
    new_dictionary = re.sub(
        rb"(/Length\s+)[0-9]+\b",
        rb"\g<1>" + str(len(new_stream)).encode("ascii"),
        dictionary,
        count=1,
    )
    return (
        content[: header.start()]
        + new_dictionary
        + new_stream
        + content[header.end() + old_length :]
    )


def inspect_synthetic_pdf(content: bytes) -> str:
    if not content.startswith(b"%PDF-"):
        raise AssertionError("invalid PDF envelope")
    if content.count(b"%%EOF") != 1 or re.fullmatch(
        rb".*%%EOF[\r\n]*", content, re.DOTALL
    ) is None:
        raise AssertionError("PDF contains bytes after physical EOF")

    object_matches = list(
        re.finditer(
            rb"(?:^|\n)([0-9]+)\s+0\s+obj\s*(.*?)\s*endobj\b",
            content,
            re.DOTALL,
        )
    )
    objects = {int(match.group(1)): match.group(2) for match in object_matches}
    if len(objects) != len(object_matches):
        raise AssertionError("PDF contains duplicate object identifiers")

    trailers = re.findall(
        rb"\btrailer\s*<<(.*?)>>\s*startxref\b",
        content,
        re.DOTALL,
    )
    if len(trailers) != 1:
        raise AssertionError("synthetic resume must contain one trailer")
    info_match = re.search(rb"/Info\s+([0-9]+)\s+0\s+R\b", trailers[0])
    if info_match is None:
        raise AssertionError("trailer has no direct Info reference")
    info_id = int(info_match.group(1))
    info = objects.get(info_id)
    if info is None:
        raise AssertionError("trailer Info reference is invalid")
    info_entries = re.findall(
        rb"/([A-Za-z]+)\s+(\([^()]*\)|/[A-Za-z]+)",
        info,
    )
    if len(info_entries) != 9:
        raise AssertionError("Info dictionary shape is not allowlisted")
    parsed_info = {
        key.decode("ascii"): (
            value[1:-1].decode("ascii") if value.startswith(b"(") else value.decode("ascii")
        )
        for key, value in info_entries
    }
    expected_info = {
        "Author": "Fictional QA Applicant",
        "CreationDate": "D:20000101000000+00'00'",
        "Creator": "Synthetic QA Fixture Generator",
        "Keywords": "",
        "ModDate": "D:20000101000000+00'00'",
        "Producer": "Synthetic QA Fixture Generator",
        "Subject": "Synthetic profile fixture",
        "Title": "Synthetic Resume",
        "Trapped": "/False",
    }
    info_names = re.findall(rb"/([A-Za-z]+)\b", info)
    expected_info_names = [key.encode("ascii") for key in expected_info] + [b"False"]
    if parsed_info != expected_info or sorted(info_names) != sorted(expected_info_names):
        raise AssertionError("Info dictionary value is not allowlisted")
    metadata_keys = rb"/(?:Author|CreationDate|Creator|Keywords|ModDate|Producer|Subject|Title|Trapped)\b"
    if any(
        identifier != info_id and re.search(metadata_keys, value)
        for identifier, value in objects.items()
    ):
        raise AssertionError("PDF contains an extra metadata dictionary")

    catalogs = [
        identifier
        for identifier, value in objects.items()
        if re.search(rb"/Type\s*/Catalog\b", value)
    ]
    if len(catalogs) != 1:
        raise AssertionError("synthetic resume must contain one catalog")
    pages_match = re.search(rb"/Pages\s+([0-9]+)\s+0\s+R\b", objects[catalogs[0]])
    if pages_match is None:
        raise AssertionError("catalog has no direct pages reference")
    pages_id = int(pages_match.group(1))
    pages = objects.get(pages_id, b"")
    if re.search(rb"/Type\s*/Pages\b", pages) is None:
        raise AssertionError("catalog pages reference is invalid")
    count_match = re.search(rb"/Count\s+([0-9]+)\b", pages)
    kids_match = re.search(rb"/Kids\s*\[(.*?)\]", pages, re.DOTALL)
    if count_match is None or int(count_match.group(1)) != 1 or kids_match is None:
        raise AssertionError("synthetic resume page tree must declare Count 1")
    kid_source = kids_match.group(1)
    kid_refs = [
        int(value)
        for value in re.findall(rb"([0-9]+)\s+0\s+R\b", kid_source)
    ]
    if re.sub(rb"[0-9]+\s+0\s+R\b", b"", kid_source).strip():
        raise AssertionError("page tree contains an unsupported kid")
    if len(kid_refs) != 1 or len(set(kid_refs)) != len(kid_refs):
        raise AssertionError("page tree must contain one unique page kid")
    page_ids = {
        identifier
        for identifier, value in objects.items()
        if re.search(rb"/Type\s*/Page(?!s\b)", value)
    }
    if page_ids != set(kid_refs):
        raise AssertionError("page tree contains an orphan or missing page")
    page = objects[kid_refs[0]]
    if re.search(
        rb"/Parent\s+" + str(pages_id).encode("ascii") + rb"\s+0\s+R\b",
        page,
    ) is None:
        raise AssertionError("page parent does not match the pages tree")
    contents_match = re.search(rb"/Contents\s+([0-9]+)\s+0\s+R\b", page)
    if contents_match is None:
        raise AssertionError("page has no single direct content stream")
    content_id = int(contents_match.group(1))
    if any(
        identifier not in {info_id, content_id}
        and (b"(" in value or b")" in value)
        for identifier, value in objects.items()
    ):
        raise AssertionError("PDF contains an unsupported container literal string")

    forbidden_features = (
        rb"/Action\b",
        rb"/URI\b",
        rb"/JavaScript\b",
        rb"/JS\b",
        rb"/Launch\b",
        rb"/GoToR\b",
        rb"/SubmitForm\b",
        rb"/RichMedia\b",
        rb"/EmbeddedFile\b",
        rb"/AcroForm\b",
        rb"/Annots\b",
        rb"/OpenAction\b",
        rb"/AA\b",
        rb"/ObjStm\b",
        rb"/XObject\b",
        rb"/ToUnicode\b",
        rb"/FontFile[23]?\b",
        rb"/Subtype\s*/(?:Type0|Type3)\b",
        rb"/Encoding\s+/(?!WinAnsiEncoding\b)",
        rb"/Metadata\b",
        rb"<\?xpacket\b",
        rb"<x:xmpmeta\b",
    )

    stream_objects = {
        identifier: value
        for identifier, value in objects.items()
        if re.search(rb"\bstream\r?\n", value)
    }
    if set(stream_objects) != {content_id}:
        raise AssertionError("PDF contains an orphan or missing content stream")
    stream_object = stream_objects[content_id]
    header = re.match(rb"<<(.*?)>>\s*stream\r?\n", stream_object, re.DOTALL)
    if header is None:
        raise AssertionError("synthetic resume has no inspectable content stream")
    dictionary = header.group(1)
    if re.search(rb"/Filter\s*\[\s*/FlateDecode\s*\]", dictionary) is None:
        raise AssertionError("unsupported PDF content stream filter")
    if len(re.findall(rb"/Filter\b", dictionary)) != 1:
        raise AssertionError("unsupported PDF content stream filter")
    length_match = re.search(rb"/Length\s+([0-9]+)\b", dictionary)
    if length_match is None:
        raise AssertionError("PDF stream has no direct bounded length")
    length = int(length_match.group(1))
    stream = stream_object[header.end() : header.end() + length]
    if len(stream) != length:
        raise AssertionError("truncated PDF stream")
    try:
        decoded = zlib.decompress(stream)
    except zlib.error as error:
        raise AssertionError("invalid compressed PDF stream") from error
    if len(decoded) > 1_000_000:
        raise AssertionError("PDF content stream exceeds inspection limit")

    inspectable = content + decoded
    if any(re.search(pattern, inspectable) for pattern in forbidden_features):
        raise AssertionError("synthetic resume contains an active PDF feature")
    if b"<" in decoded or b">" in decoded:
        raise AssertionError("unsupported hex string in PDF content")
    if b"[" in decoded or b"]" in decoded or re.search(rb"\bTJ\b", decoded):
        raise AssertionError("unsupported PDF text array")
    if re.search(rb"(?:^|\s)(?:'|\")(?=\s|$)", decoded):
        raise AssertionError("unsupported PDF text-show operator")
    if re.search(rb"(?:^|\s)(?:Do|BI|ID|EI)(?=\s|$)", decoded):
        raise AssertionError("unsupported PDF graphical text content")

    strings: list[bytes] = []
    index = 0
    while index < len(decoded):
        if decoded[index] != ord("("):
            index += 1
            continue
        index += 1
        depth = 1
        value = bytearray()
        while index < len(decoded) and depth:
            current = decoded[index]
            index += 1
            if current == ord("\\"):
                if index >= len(decoded):
                    raise AssertionError("unterminated PDF string escape")
                escaped = decoded[index]
                index += 1
                if escaped in b"()\\":
                    value.append(escaped)
                elif ord("0") <= escaped <= ord("7"):
                    digits = bytearray([escaped])
                    while (
                        len(digits) < 3
                        and index < len(decoded)
                        and ord("0") <= decoded[index] <= ord("7")
                    ):
                        digits.append(decoded[index])
                        index += 1
                    value.append(int(digits, 8))
                else:
                    raise AssertionError("unsupported PDF string escape")
            elif current == ord("("):
                depth += 1
                value.append(current)
            elif current == ord(")"):
                depth -= 1
                if depth:
                    value.append(current)
            else:
                value.append(current)
        if depth:
            raise AssertionError("unterminated PDF string")
        if any(byte < 0x20 or byte > 0x7E for byte in value):
            raise AssertionError("unsupported PDF text encoding")
        operator = re.match(rb"\s+([A-Za-z*]+)\b", decoded[index:])
        if operator is None or operator.group(1) != b"Tj":
            raise AssertionError("literal PDF text must use the Tj operator")
        strings.append(bytes(value))

    extracted = b"\n".join(strings).decode("latin-1")

    stream_start = content.find(stream, header.end())
    if stream_start < 0:
        raise AssertionError("content stream binding changed")
    container = content[:stream_start] + content[stream_start + len(stream) :]
    comments = [
        value.decode("ascii", errors="ignore")
        for value in re.findall(rb"(?m)^%([^\r\n]*)", container)
    ]
    id_matches = re.findall(
        rb"/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]",
        trailers[0],
    )
    if len(id_matches) != 1 or any(len(value) != 32 for value in id_matches[0]):
        raise AssertionError("trailer ID is not allowlisted PDF machinery")
    container_without_id = re.sub(
        rb"/ID\s*\[\s*<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\]",
        b"",
        container,
    )
    if re.search(rb"(?<!<)<(?!<)|(?<!>)>(?!>)", container_without_id):
        raise AssertionError("PDF contains an unsupported container hex string")

    scanned_text = "\n".join(list(expected_info.values()) + comments + [extracted])
    if re.search(r"\b[a-z][a-z0-9+.-]*://|\bwww\.", scanned_text, re.IGNORECASE):
        raise AssertionError("PDF contains a URL")
    emails = re.findall(
        r"(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}",
        scanned_text,
        re.IGNORECASE,
    )
    if any(value.casefold() != "avery.replay@example.com" for value in emails):
        raise AssertionError("PDF contains a non-reserved email")
    denied_terms = (
        "linkedin",
        "http://",
        "https://",
        "company",
        "school",
        "university",
        "college",
        "employment",
        "work history",
        "education",
        "person",
    )
    for denied in denied_terms:
        if re.search(rf"\b{re.escape(denied)}\b", scanned_text, re.IGNORECASE):
            raise AssertionError("synthetic resume contains denied text")
    expected_comments = [
        "PDF-1.4",
        " ReportLab Generated PDF document (opensource)",
        " ReportLab generated PDF document -- digest (opensource)",
        "%EOF",
    ]
    if comments != expected_comments:
        raise AssertionError("PDF comment is not allowlisted machinery")
    expected_visible_strings = [
        "AVERY REPLAY",
        "Fictional Applicant",
        "Phoenix, Arizona  |  avery.replay@example.com  |  602-555-0142",
        "PROFILE",
        "Fictional applicant profile prepared for a repeatable form-filling quality-assurance scenario.",
        "SKILLS",
        "Communication",
        "Organization",
        "Problem solving",
        "Attention to detail",
        "Synthetic fixture for repeatable quality assurance",
    ]
    if [value.decode("ascii") for value in strings] != expected_visible_strings:
        raise AssertionError("visible PDF text is not allowlisted")
    return extracted


def validate_committed_synthetic_pdf(content: bytes) -> str:
    extracted = inspect_synthetic_pdf(content)
    if hashlib.sha256(content).hexdigest() != SYNTHETIC_RESUME_SHA256:
        raise AssertionError("reviewed synthetic resume digest changed")
    return extracted


def load_cli():
    spec = importlib.util.spec_from_file_location("qa_replay_cli", SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError("unable to load replay coordinator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReplayCoordinatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data_root = Path(self.temporary.name)
        self.fixtures = self.data_root / "fixtures"
        self.scenarios = self.data_root / "scenarios"
        self.runs = self.data_root / "runs"
        fixture_dir = self.fixtures / FIXTURE_ID
        scenario_dir = self.scenarios / SCENARIO_ID
        fixture_dir.mkdir(parents=True)
        scenario_dir.mkdir(parents=True)

        capture = json.loads((PRIVATE_CAPTURE / "semantic.json").read_text())
        receipt = json.loads(
            (PRIVATE_CAPTURE / "capture-receipt.json").read_text()
        )
        self.fixture = compile_capture(capture, receipt, FIXTURE_ID)
        (fixture_dir / "fixture.json").write_text(json.dumps(self.fixture))
        self.profile = {
            "name": "Avery Example",
            "email": "avery@example.com",
            "resumePath": "synthetic-resume.pdf",
        }
        (scenario_dir / "profile.json").write_text(json.dumps(self.profile))
        (scenario_dir / "synthetic-resume.pdf").write_bytes(
            b"%PDF-1.4\nsynthetic fixture\n%%EOF\n"
        )
        (scenario_dir / "expected.json").write_text(
            json.dumps(
                {
                    "controlIds": [
                        control["id"]
                        for step in self.fixture["steps"]
                        for control in step["controls"]
                    ],
                    "resumeFilename": "synthetic-resume.pdf",
                }
            )
        )
        self.cli = load_cli()
        self.cli.FIXTURES_ROOT = self.fixtures
        self.cli.SCENARIOS_ROOT = self.scenarios
        self.cli.RUNS_ROOT = self.runs
        self.server_cleanup = None

    def tearDown(self) -> None:
        if self.server_cleanup is not None:
            url, token = self.server_cleanup
            try:
                request = urllib.request.Request(
                    self.base_url(url) + "/__qa/shutdown",
                    headers={"X-QA-Run-Token": token},
                    method="POST",
                )
                urllib.request.urlopen(request, timeout=2).close()
            except (OSError, urllib.error.URLError):
                pass

    def invoke(self, arguments: list[str]):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = self.cli.main(arguments)
        output = json.loads(stdout.getvalue()) if stdout.getvalue() else None
        return code, output, stderr.getvalue()

    def prepare(self):
        code, output, stderr = self.invoke(
            ["prepare", "--fixture", FIXTURE_ID, "--scenario", SCENARIO_ID]
        )
        self.assertEqual((code, stderr), (0, ""))
        run_root = Path(output["storeRoot"]).parent
        state = json.loads((run_root / "run.json").read_text())
        self.server_cleanup = (output["url"], state["shutdownToken"])
        return output, run_root, state

    def base_url(self, url: str) -> str:
        parsed = urlsplit(url)
        return f"{parsed.scheme}://{parsed.netloc}"

    def test_prepare_creates_isolated_store_and_starts_server(self) -> None:
        output, run_root, state = self.prepare()

        self.assertEqual(
            set(output),
            {"fixtureId", "scenarioId", "url", "storeRoot", "suggestedPrompt"},
        )
        self.assertEqual(output["fixtureId"], FIXTURE_ID)
        self.assertEqual(output["scenarioId"], SCENARIO_ID)
        self.assertEqual(output["suggestedPrompt"], PROMPT.format(url=output["url"]))
        route_token = parse_qs(urlsplit(output["url"]).fragment)["qa-route"][0]
        self.assertRegex(
            route_token,
            r"^qa-run-20[0-9]{6}-[a-f0-9]{8}\.[a-f0-9]{64}$",
        )
        code, route, stderr = self.invoke(["resolve", "--route-token", route_token])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(route, {"storeRoot": output["storeRoot"]})
        stored_profile = json.loads(
            (run_root / "store/profile.json").read_text()
        )["profile"]
        self.assertEqual(stored_profile["name"], self.profile["name"])
        self.assertEqual(stored_profile["email"], self.profile["email"])
        self.assertEqual(
            Path(stored_profile["resumePath"]),
            (run_root / "synthetic-resume.pdf").resolve(),
        )
        self.assertEqual(
            json.loads((run_root / "profile.json").read_text()), self.profile
        )
        self.assertEqual(
            (run_root / "synthetic-resume.pdf").read_bytes(),
            b"%PDF-1.4\nsynthetic fixture\n%%EOF\n",
        )
        self.assertEqual(state["url"], self.base_url(output["url"]))
        self.assertNotIn("serverPid", state)
        self.assertEqual(stat.S_IMODE(run_root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((run_root / "run.json").stat().st_mode), 0o600)
        with urllib.request.urlopen(self.base_url(output["url"]) + "/__qa/state", timeout=2) as response:
            self.assertEqual(json.load(response), {"events": [], "finalActionActivations": 0})

    def test_prepare_uses_closed_greenhouse_guidance_without_changing_shape(self) -> None:
        self.cli.FIXTURES_ROOT = ROOT / "qa/fixtures"
        self.cli.SCENARIOS_ROOT = ROOT / "qa/scenarios"
        output = self.cli._prepare(
            "greenhouse-single-page-2026-08-v1", "greenhouse-complete-profile"
        )
        run_root = Path(output["storeRoot"]).parent
        state = json.loads((run_root / "run.json").read_text())
        self.server_cleanup = (output["url"], state["shutdownToken"])

        self.assertEqual(
            set(output),
            {"fixtureId", "scenarioId", "url", "storeRoot", "suggestedPrompt"},
        )
        self.assertEqual(
            output["suggestedPrompt"],
            PROMPT.format(url=output["url"]).replace(
                "LinkedIn Easy Apply", "Greenhouse"
            ),
        )
        code, started, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(started["changed"])
        fixture = json.loads((run_root / "fixture.json").read_text())
        for step in fixture["steps"]:
            for control in step["controls"]:
                self._post_event(
                    output["url"],
                    {
                        "type": "uploaded" if control["role"] == "file" else "filled",
                        "controlId": control["id"],
                        "stepId": step["id"],
                        **(
                            {"expectedFilenameMatched": True}
                            if control["role"] == "file"
                            else {}
                        ),
                    },
                )
            self._post_event(
                output["url"],
                {
                    "type": "reviewed" if step["kind"] == "review" else "advanced",
                    "controlId": "",
                    "stepId": step["id"],
                },
            )
        code, reviewed, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(reviewed["changed"])
        session = json.loads(
            (Path(output["storeRoot"]) / "sessions" / f"{run_root.name}.json").read_text()
        )
        self.assertEqual((session["ats"], session["status"]), ("greenhouse", "review"))

    def test_prepare_uses_closed_ashby_guidance_without_changing_shape(self) -> None:
        fixture_id = "ashby-application-2026-08-v1"
        scenario_id = "ashby-complete-profile"
        fixture_dir = self.fixtures / fixture_id
        scenario_dir = self.scenarios / scenario_id
        fixture_dir.mkdir()
        scenario_dir.mkdir()
        fixture = json.loads(json.dumps(self.fixture))
        fixture["id"] = fixture_id
        fixture["platformFamily"] = "ashby"
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [
                    {"id": "contact.full_name", "kind": "contact.full_name", "role": "textbox", "label": "Full name", "required": True},
                    {"id": "contact.email", "kind": "contact.email", "role": "textbox", "label": "Email address", "required": True},
                    {"id": "resume.file", "kind": "resume.file", "role": "file", "label": "Resume", "required": True},
                ],
                "next": "review",
            },
            fixture["steps"][-1],
        ]
        (fixture_dir / "fixture.json").write_text(json.dumps(fixture))
        profile = json.loads(
            (ROOT / "qa/scenarios/ashby-complete-profile/profile.json").read_text()
        )
        (scenario_dir / "profile.json").write_text(json.dumps(profile))
        (scenario_dir / "expected.json").write_text(json.dumps({
            "controlIds": ["contact.full_name", "contact.email", "resume.file"],
            "resumeFilename": "synthetic-resume.pdf",
        }))
        (scenario_dir / "synthetic-resume.pdf").write_bytes(
            (ROOT / "qa/scenarios/ashby-complete-profile/synthetic-resume.pdf").read_bytes()
        )

        output = self.cli._prepare(fixture_id, scenario_id)
        run_root = Path(output["storeRoot"]).parent
        state = json.loads((run_root / "run.json").read_text())
        self.server_cleanup = (output["url"], state["shutdownToken"])
        self.assertEqual(
            set(output),
            {"fixtureId", "scenarioId", "url", "storeRoot", "suggestedPrompt"},
        )
        self.assertEqual(
            output["suggestedPrompt"],
            PROMPT.format(url=output["url"]).replace("LinkedIn Easy Apply", "Ashby"),
        )

    def test_prepare_uses_closed_lever_guidance_without_changing_shape(self) -> None:
        fixture_id = "lever-application-2026-08-v1"
        scenario_id = "lever-complete-profile"
        fixture_dir = self.fixtures / fixture_id
        scenario_dir = self.scenarios / scenario_id
        fixture_dir.mkdir()
        scenario_dir.mkdir()
        fixture = json.loads(json.dumps(self.fixture))
        fixture["id"] = fixture_id
        fixture["platformFamily"] = "lever"
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [
                    generic_control(kind, required)
                    for kind, required in LEVER_CONTROL_PROFILE
                ],
                "next": "review",
            },
            fixture["steps"][-1],
        ]
        (fixture_dir / "fixture.json").write_text(json.dumps(fixture))
        source_scenario = ROOT / "qa/scenarios/lever-complete-profile"
        for filename in ("profile.json", "expected.json", "synthetic-resume.pdf"):
            target = scenario_dir / filename
            source = source_scenario / filename
            if filename.endswith(".pdf"):
                target.write_bytes(source.read_bytes())
            else:
                target.write_text(source.read_text())

        output = self.cli._prepare(fixture_id, scenario_id)
        run_root = Path(output["storeRoot"]).parent
        state = json.loads((run_root / "run.json").read_text())
        self.server_cleanup = (output["url"], state["shutdownToken"])
        self.assertEqual(
            set(output),
            {"fixtureId", "scenarioId", "url", "storeRoot", "suggestedPrompt"},
        )
        self.assertEqual(
            output["suggestedPrompt"],
            PROMPT.format(url=output["url"]).replace("LinkedIn Easy Apply", "Lever"),
        )

    def _record_complete_replay_events(self, output: dict) -> None:
        for step in self.fixture["steps"]:
            for control in step["controls"]:
                self._post_event(
                    output["url"],
                    {
                        "type": "uploaded" if control["role"] == "file" else "filled",
                        "controlId": control["id"],
                        "stepId": step["id"],
                        **(
                            {"expectedFilenameMatched": True}
                            if control["role"] == "file"
                            else {}
                        ),
                    },
                )
            self._post_event(
                output["url"],
                {
                    "type": "reviewed" if step["kind"] == "review" else "advanced",
                    "controlId": "",
                    "stepId": step["id"],
                },
            )

    def test_supported_lifecycle_is_ordered_idempotent_and_evaluates(self) -> None:
        output, run_root, _state = self.prepare()
        code, result, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(result["changed"])
        code, repeated, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertFalse(repeated["changed"])

        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual(code, 2)
        self.assertIsNone(result)
        self.assertEqual(stderr, "replay review event not observed\n")

        self._record_complete_replay_events(output)
        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(result["changed"])
        code, repeated, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertFalse(repeated["changed"])

        history = [
            json.loads(line)
            for line in (Path(output["storeRoot"]) / "applications.jsonl").read_text().splitlines()
        ]
        self.assertEqual([event["event"] for event in history], ["started", "reviewed"])
        self.assertTrue(all(event["applicationId"] == run_root.name for event in history))
        serialized = json.dumps(history)
        for forbidden in (self.profile["name"], self.profile["email"], output["url"]):
            self.assertNotIn(forbidden, serialized)

        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(report["status"], "passed")
        self.server_cleanup = None
        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual(code, 2)
        self.assertIsNone(result)
        self.assertEqual(stderr, "run is terminal\n")

    def test_supported_lifecycle_evaluate_cleanup_and_tombstone_retry(self) -> None:
        output, run_root, _state = self.prepare()
        code, started, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(started["changed"])

        self._record_complete_replay_events(output)
        code, reviewed, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(reviewed["changed"])
        self.assertTrue((run_root / "evaluate.lock").is_file())

        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        retained_report = (run_root / "report.json").read_bytes()
        self.server_cleanup = None

        expected = {
            "runId": run_root.name,
            "state": "completed",
            "reportRetained": True,
        }
        code, cleanup, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, cleanup, stderr), (0, expected, ""))
        retained_tombstone = (run_root / "tombstone.json").read_bytes()
        self.assertEqual((run_root / "report.json").read_bytes(), retained_report)
        for path in run_root.rglob("*"):
            if path.is_file() and path.name not in {"report.json", "tombstone.json"}:
                self.assertEqual(path.stat().st_size, 0, path.relative_to(run_root))

        code, cleanup, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, cleanup, stderr), (0, expected, ""))
        self.assertEqual((run_root / "report.json").read_bytes(), retained_report)
        self.assertEqual(
            (run_root / "tombstone.json").read_bytes(), retained_tombstone
        )

    def test_reviewed_rejects_missing_started_and_final_action_activation(self) -> None:
        output, run_root, _state = self.prepare()
        self._record_complete_replay_events(output)
        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual(code, 2)
        self.assertIsNone(result)
        self.assertEqual(stderr, "isolated lifecycle transition failed\n")

        code, _result, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        review_id = next(
            step["id"] for step in self.fixture["steps"] if step["kind"] == "review"
        )
        base_url = self.base_url(output["url"])
        request = urllib.request.Request(
            base_url + "/__qa/final-action",
            data=json.dumps({"stepId": review_id}).encode(),
            headers={"Content-Type": "application/json", "Origin": base_url},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as captured:
            urllib.request.urlopen(request, timeout=2)
        try:
            self.assertEqual(captured.exception.code, 409)
        finally:
            captured.exception.close()
        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual(code, 2)
        self.assertIsNone(result)
        self.assertEqual(stderr, "replay final action was activated\n")

    def _write_passing_store(self, store_root: Path) -> None:
        application_id = "application-1"
        history = [
            {
                "schemaVersion": 1,
                "eventId": "event-started",
                "applicationId": application_id,
                "event": "started",
                "answerKeys": [],
                "at": "2026-08-11T12:00:00Z",
            },
            {
                "schemaVersion": 1,
                "eventId": "event-reviewed",
                "applicationId": application_id,
                "event": "reviewed",
                "answerKeys": [],
                "at": "2026-08-11T12:01:00Z",
            },
        ]
        (store_root / "applications.jsonl").write_text(
            "".join(json.dumps(item) + "\n" for item in history)
        )
        session = {
            "schemaVersion": 1,
            "applicationId": application_id,
            "status": "review",
            "step": "review",
            "answerKeys": [],
            "pendingFields": [],
            "createdAt": "2026-08-11T12:00:00Z",
            "updatedAt": "2026-08-11T12:01:00Z",
        }
        (store_root / "sessions" / f"{application_id}.json").write_text(
            json.dumps(session)
        )

    def _post_event(self, url: str, event: dict) -> None:
        url = self.base_url(url)
        request = urllib.request.Request(
            url + "/__qa/event",
            data=json.dumps(event).encode(),
            headers={"Content-Type": "application/json", "Origin": url},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            self.assertEqual(response.status, 204)

    def test_evaluate_writes_redacted_report_and_returns_zero_for_pass(self) -> None:
        output, run_root, _state = self.prepare()
        for step in self.fixture["steps"]:
            for control in step["controls"]:
                self._post_event(
                    output["url"],
                    {
                        "type": "uploaded" if control["role"] == "file" else "filled",
                        "controlId": control["id"],
                        "stepId": step["id"],
                        **(
                            {"expectedFilenameMatched": True}
                            if control["role"] == "file"
                            else {}
                        ),
                    },
                )
            self._post_event(
                output["url"],
                {
                    "type": "reviewed" if step["kind"] == "review" else "advanced",
                    "controlId": "",
                    "stepId": step["id"],
                },
            )
        self._write_passing_store(Path(output["storeRoot"]))

        code, report, stderr = self.invoke(
            ["evaluate", "--run-id", run_root.name]
        )

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(report["status"], "passed")
        self.assertEqual(
            json.loads((run_root / "report.json").read_text()), report
        )
        serialized = json.dumps(report)
        self.assertNotIn("Avery Example", serialized)
        self.assertNotIn("avery@example.com", serialized)
        self.server_cleanup = None

        second_code, second_report, second_stderr = self.invoke(
            ["evaluate", "--run-id", run_root.name]
        )
        self.assertEqual((second_code, second_stderr), (0, ""))
        self.assertEqual(second_report, report)

    def test_evaluate_returns_one_for_assertion_failure_and_stops_server(self) -> None:
        _output, run_root, state = self.prepare()

        code, report, stderr = self.invoke(
            ["evaluate", "--run-id", run_root.name]
        )

        self.assertEqual((code, stderr), (1, ""))
        self.assertEqual(report["status"], "failed")
        self.assertTrue((run_root / "report.json").is_file())
        with self.assertRaises((OSError, urllib.error.URLError)):
            urllib.request.urlopen(
                self.base_url(_output["url"]) + "/__qa/state", timeout=1
            )
        self.server_cleanup = None

    def test_rejects_invalid_identifiers_without_creating_a_run(self) -> None:
        code, output, stderr = self.invoke(
            ["prepare", "--fixture", "../private", "--scenario", SCENARIO_ID]
        )
        self.assertEqual(code, 2)
        self.assertIsNone(output)
        self.assertEqual(stderr, "invalid fixture identifier\n")
        self.assertFalse(self.runs.exists())

    def test_prepare_rejects_preexisting_nonprivate_runs_root(self) -> None:
        self.runs.mkdir(mode=0o755)
        os.chmod(self.runs, 0o755)

        code, output, stderr = self.invoke(
            ["prepare", "--fixture", FIXTURE_ID, "--scenario", SCENARIO_ID]
        )

        self.assertEqual(
            (code, output, stderr),
            (2, None, "run directory creation failed\n"),
        )
        self.assertEqual(stat.S_IMODE(self.runs.stat().st_mode), 0o755)

    def test_evaluate_rejects_symlinked_run_state(self) -> None:
        self.runs.mkdir()
        run_root = self.runs / "qa-run-20260811-deadbeef"
        run_root.mkdir()
        target = self.data_root / "outside.json"
        target.write_text("{}")
        (run_root / "run.json").symlink_to(target)

        code, output, stderr = self.invoke(
            ["evaluate", "--run-id", run_root.name]
        )

        self.assertEqual(code, 2)
        self.assertIsNone(output)
        self.assertEqual(stderr, "invalid run state\n")

    def test_prepare_never_touches_default_or_legacy_store(self) -> None:
        home = self.data_root / "home"
        default_store = home / ".job-apply"
        default_store.mkdir(parents=True)
        sentinel = default_store / "sentinel.txt"
        sentinel.write_text("keep")
        legacy = home / ".claude-job-profile.json"
        legacy.write_text(json.dumps({"private": "do not copy"}))

        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            output, run_root, _state = self.prepare()

        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual(legacy.read_text(), json.dumps({"private": "do not copy"}))
        self.assertNotIn("do not copy", (run_root / "store/profile.json").read_text())
        route_token = parse_qs(urlsplit(output["url"]).fragment)["qa-route"][0]
        self.assertEqual(
            self.invoke(["resolve", "--route-token", route_token])[1],
            {"storeRoot": output["storeRoot"]},
        )

    def test_wrong_route_token_and_server_token_fail_closed(self) -> None:
        output, run_root, state = self.prepare()
        code, route, stderr = self.invoke(["resolve", "--route-token", "b" * 64])
        self.assertEqual((code, route, stderr), (2, None, "unknown QA route\n"))

        state_path = run_root / "run.json"
        original = json.loads(state_path.read_text())
        tampered = dict(original)
        tampered["shutdownToken"] = "b" * 64
        state_path.write_text(json.dumps(tampered))
        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual((code, report, stderr), (2, None, "fixture server identity mismatch\n"))
        with urllib.request.urlopen(
            self.base_url(output["url"]) + "/__qa/state", timeout=2
        ) as response:
            self.assertEqual(response.status, 200)
        state_path.write_text(json.dumps(original))

    def test_evaluate_lock_prevents_concurrent_or_replayed_mutation(self) -> None:
        _output, run_root, _state = self.prepare()
        lock = os.open(run_root / "evaluate.lock", os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])

        self.assertEqual(
            (code, report, stderr),
            (2, None, "evaluation already in progress\n"),
        )

    def test_terminal_publication_serializes_with_lifecycle_transition(self) -> None:
        _output, run_root, state = self.prepare()
        lock = os.open(run_root / "evaluate.lock", os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

        with ThreadPoolExecutor(max_workers=1) as executor:
            transition = executor.submit(
                self.cli._record_transition, run_root.name, "started"
            )
            time.sleep(0.05)
            self.assertFalse(transition.done())
            (run_root / "completed.json").write_text(
                json.dumps(
                    {"state": "completed", "nonce": state["lifecycleNonce"]}
                )
            )
            fcntl.flock(lock, fcntl.LOCK_UN)
            with self.assertRaisesRegex(self.cli.CoordinatorError, "run is terminal"):
                transition.result(timeout=2)

        history_path = Path(state["storeRoot"]) / "applications.jsonl"
        self.assertEqual(history_path.read_text(), "")

    def test_stale_server_marks_run_abandoned_idempotently(self) -> None:
        output, run_root, state = self.prepare()
        request = urllib.request.Request(
            self.base_url(output["url"]) + "/__qa/shutdown",
            headers={"X-QA-Run-Token": state["shutdownToken"]},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=2).close()
        self.server_cleanup = None

        first = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual(first, (2, None, "fixture server unavailable\n"))
        self.assertEqual(
            json.loads((run_root / "abandoned.json").read_text())["state"],
            "abandoned",
        )
        second = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual(second, (2, None, "run is abandoned\n"))

    def test_tampered_completed_report_never_echoes_injected_values(self) -> None:
        _output, run_root, state = self.prepare()
        (run_root / "report.json").write_text(
            json.dumps({"status": "passed", "secret": "DO NOT ECHO"})
        )
        (run_root / "completed.json").write_text(
            json.dumps(
                {"state": "completed", "nonce": state["lifecycleNonce"]}
            )
        )

        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])

        self.assertEqual((code, report, stderr), (2, None, "invalid run report\n"))
        self.assertNotIn("DO NOT ECHO", stderr)

    def test_cached_report_shape_and_semantics_fail_closed(self) -> None:
        output, run_root, _state = self.prepare()
        for step in self.fixture["steps"]:
            for control in step["controls"]:
                self._post_event(
                    output["url"],
                    {
                        "type": "uploaded" if control["role"] == "file" else "filled",
                        "controlId": control["id"],
                        "stepId": step["id"],
                        **(
                            {"expectedFilenameMatched": True}
                            if control["role"] == "file"
                            else {}
                        ),
                    },
                )
            self._post_event(
                output["url"],
                {
                    "type": "reviewed" if step["kind"] == "review" else "advanced",
                    "controlId": "",
                    "stepId": step["id"],
                },
            )
        self._write_passing_store(Path(output["storeRoot"]))
        self.assertEqual(self.invoke(["evaluate", "--run-id", run_root.name])[0], 0)
        self.server_cleanup = None
        report_path = run_root / "report.json"
        valid = json.loads(report_path.read_text())
        cases = []
        malformed = dict(valid)
        malformed["missingControlIds"] = [{}]
        cases.append(malformed)
        malformed = dict(valid)
        malformed["missingControlIds"] = ["resume.file", "resume.file"]
        cases.append(malformed)
        malformed = json.loads(json.dumps(valid))
        malformed["assertions"]["review-reached"] = "failed"
        cases.append(malformed)
        malformed = dict(valid)
        malformed["status"] = "failed"
        cases.append(malformed)
        malformed = dict(valid)
        malformed["failureCategories"] = ["unknown-category"]
        cases.append(malformed)
        for malformed in cases:
            with self.subTest(malformed=malformed):
                report_path.write_text(json.dumps(malformed))
                os.chmod(report_path, 0o600)
                code, report, stderr = self.invoke(
                    ["evaluate", "--run-id", run_root.name]
                )
                self.assertEqual((code, report, stderr), (2, None, "invalid run report\n"))

    def test_route_resolution_is_direct_with_more_than_256_retained_runs(self) -> None:
        self.runs.mkdir(mode=0o700)
        os.chmod(self.runs, 0o700)
        for index in range(300):
            (self.runs / f"retained-{index:03d}").mkdir()
        output, _run_root, _state = self.prepare()
        route = parse_qs(urlsplit(output["url"]).fragment)["qa-route"][0]

        code, resolved, stderr = self.invoke(["resolve", "--route-token", route])

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(resolved, {"storeRoot": output["storeRoot"]})

    def test_run_parent_replacement_keeps_store_and_report_descriptor_anchored(self) -> None:
        output, run_root, _state = self.prepare()
        for step in self.fixture["steps"]:
            for control in step["controls"]:
                self._post_event(
                    output["url"],
                    {
                        "type": "uploaded" if control["role"] == "file" else "filled",
                        "controlId": control["id"],
                        "stepId": step["id"],
                        **(
                            {"expectedFilenameMatched": True}
                            if control["role"] == "file"
                            else {}
                        ),
                    },
                )
            self._post_event(
                output["url"],
                {
                    "type": "reviewed" if step["kind"] == "review" else "advanced",
                    "controlId": "",
                    "stepId": step["id"],
                },
            )
        self._write_passing_store(Path(output["storeRoot"]))
        displaced = self.runs / "anchored-original"
        original_verify = self.cli._verify_identity

        def replace_parent(state):
            run_root.rename(displaced)
            run_root.mkdir(mode=0o700)
            os.chmod(run_root, 0o700)
            return original_verify(state)

        with mock.patch.object(self.cli, "_verify_identity", side_effect=replace_parent):
            code, report, stderr = self.invoke(
                ["evaluate", "--run-id", run_root.name]
            )

        self.assertEqual((code, report["status"], stderr), (0, "passed", ""))
        self.assertTrue((displaced / "report.json").is_file())
        self.assertFalse((run_root / "report.json").exists())
        self.server_cleanup = None

    def test_cleanup_abandons_prepared_run_and_is_idempotent(self) -> None:
        output, run_root, _state = self.prepare()
        route = parse_qs(urlsplit(output["url"]).fragment)["qa-route"][0]

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(
            result,
            {"runId": run_root.name, "state": "abandoned", "reportRetained": False},
        )
        self.assertTrue((run_root / "store").is_dir())
        tombstone = json.loads((run_root / "tombstone.json").read_text())
        self.assertEqual(
            set(tombstone),
            {
                "runId",
                "state",
                "reportRetained",
                "lifecycleNonce",
                "fixtureId",
                "scenarioId",
                "reportSha256",
                "mac",
            },
        )
        self.assertEqual(
            {key: tombstone[key] for key in result},
            result,
        )
        for path in run_root.rglob("*"):
            if path.is_file() and path.name != "tombstone.json":
                self.assertEqual(path.stat().st_size, 0, path)
        with self.assertRaises((OSError, urllib.error.URLError)):
            urllib.request.urlopen(
                self.base_url(output["url"]) + "/__qa/state", timeout=1
            )
        self.server_cleanup = None
        self.assertEqual(
            self.invoke(["resolve", "--route-token", route]),
            (2, None, "unknown QA route\n"),
        )
        self.assertEqual(
            self.invoke(["evaluate", "--run-id", run_root.name]),
            (2, None, "invalid run state\n"),
        )
        self.assertEqual(
            self.invoke(["cleanup", "--run-id", run_root.name]),
            (0, result, ""),
        )

    def test_cleanup_preserves_shutdown_capability_when_server_is_unavailable(self) -> None:
        output, run_root, state = self.prepare()
        original_request = self.cli._authenticated_request

        def unavailable_identity(url, path, token, method="GET"):
            if path == "/__qa/identity":
                raise self.cli.CoordinatorError("fixture server unavailable")
            return original_request(url, path, token, method)

        with mock.patch.object(
            self.cli, "_authenticated_request", side_effect=unavailable_identity
        ):
            result = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(result, (2, None, "fixture server unavailable\n"))
        self.assertEqual(json.loads((run_root / "run.json").read_text()), state)
        self.assertFalse((run_root / "abandoned.json").exists())
        self.assertFalse((run_root / "tombstone.json").exists())
        with urllib.request.urlopen(
            self.base_url(output["url"]) + "/__qa/state", timeout=1
        ) as response:
            self.assertEqual(response.status, 200)

        code, cleanup, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, cleanup["state"], stderr), (0, "abandoned", ""))
        self.server_cleanup = None

    def test_cleanup_sanitizes_completed_synthetic_data_but_retains_report(self) -> None:
        output, run_root, _state = self.prepare()
        code, report, _stderr = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual(code, 1)
        self.server_cleanup = None

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(result["state"], "completed")
        self.assertTrue(result["reportRetained"])
        self.assertEqual(json.loads((run_root / "report.json").read_text()), report)
        for path in run_root.rglob("*"):
            if path.is_file() and path.name not in {"report.json", "tombstone.json"}:
                self.assertEqual(path.stat().st_size, 0, path)

    def test_cleanup_never_stops_a_server_that_fails_run_authentication(self) -> None:
        output, run_root, _state = self.prepare()
        state_path = run_root / "run.json"
        state = json.loads(state_path.read_text())
        state["shutdownToken"] = "b" * 64
        state_path.write_text(json.dumps(state))
        os.chmod(state_path, 0o600)

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(
            (code, result, stderr),
            (2, None, "fixture server identity mismatch\n"),
        )
        with urllib.request.urlopen(
            self.base_url(output["url"]) + "/__qa/state", timeout=1
        ) as response:
            self.assertEqual(response.status, 200)

    def test_preplanted_tombstone_and_report_cannot_bypass_shutdown(self) -> None:
        output, run_root, _state = self.prepare()
        forged_tombstone = {
            "runId": run_root.name,
            "state": "completed",
            "reportRetained": True,
        }
        (run_root / "tombstone.json").write_text(json.dumps(forged_tombstone))
        (run_root / "report.json").write_text(
            json.dumps({"forged": "valuable report bytes"})
        )
        os.chmod(run_root / "tombstone.json", 0o600)
        os.chmod(run_root / "report.json", 0o600)

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
        self.assertFalse(result["reportRetained"])
        self.assertEqual((run_root / "report.json").stat().st_size, 0)
        with self.assertRaises((OSError, urllib.error.URLError)):
            urllib.request.urlopen(
                self.base_url(output["url"]) + "/__qa/state", timeout=1
            )
        self.server_cleanup = None

    def test_cleanup_directory_swap_at_open_preserves_replacement_bytes(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        store_opens = 0
        swapped = False

        def swap_before_open(path, flags, *args, **kwargs):
            nonlocal store_opens, swapped
            dir_fd = kwargs.get("dir_fd")
            if (
                path == "store"
                and flags & os.O_DIRECTORY
                and dir_fd is not None
            ):
                store_opens += 1
                if store_opens == 2 and not swapped:
                    swapped = True
                    os.rename(
                        path,
                        "attacker-original-store",
                        src_dir_fd=dir_fd,
                        dst_dir_fd=dir_fd,
                    )
                    os.mkdir(path, mode=0o700, dir_fd=dir_fd)
                    replacement = original_open(
                        f"{path}/valuable.bin",
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600,
                        dir_fd=dir_fd,
                    )
                    os.write(replacement, b"valuable-open-replacement")
                    os.close(replacement)
            return original_open(path, flags, *args, **kwargs)

        with mock.patch.object(self.cli.os, "open", side_effect=swap_before_open):
            result = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(result, (2, None, "run cleanup failed\n"))
        self.assertEqual(
            (run_root / "store/valuable.bin").read_bytes(),
            b"valuable-open-replacement",
        )
        self.server_cleanup = None

    def test_cleanup_regular_last_boundary_swap_preserves_replacement(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        original_truncate = self.cli.os.ftruncate
        profile_descriptor = None
        swapped = False

        def remember_profile_open(path, flags, *args, **kwargs):
            nonlocal profile_descriptor
            descriptor = original_open(path, flags, *args, **kwargs)
            if path == "profile.json" and flags & os.O_WRONLY:
                profile_descriptor = descriptor
            return descriptor

        def swap_before_truncate(descriptor, size):
            nonlocal swapped
            if descriptor == profile_descriptor and not swapped:
                swapped = True
                dir_fd = os.open(run_root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.rename(
                        "profile.json",
                        "attacker-original-profile.json",
                        src_dir_fd=dir_fd,
                        dst_dir_fd=dir_fd,
                    )
                    replacement = original_open(
                        "profile.json",
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600,
                        dir_fd=dir_fd,
                    )
                    os.write(replacement, b"valuable-last-boundary-replacement")
                    os.close(replacement)
                finally:
                    os.close(dir_fd)
            return original_truncate(descriptor, size)

        with mock.patch.object(
            self.cli.os, "open", side_effect=remember_profile_open
        ), mock.patch.object(
            self.cli.os, "ftruncate", side_effect=swap_before_truncate
        ):
            result = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(result, (2, None, "run cleanup failed\n"))
        self.assertTrue(swapped)
        self.assertEqual(
            (run_root / "profile.json").read_bytes(),
            b"valuable-last-boundary-replacement",
        )
        self.server_cleanup = None

    def test_cleanup_never_uses_pathname_deletion(self) -> None:
        _output, run_root, _state = self.prepare()

        with mock.patch.object(
            self.cli.os, "unlink", side_effect=AssertionError("unlink called")
        ), mock.patch.object(
            self.cli.os, "rmdir", side_effect=AssertionError("rmdir called")
        ):
            code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
        self.server_cleanup = None

    def test_cleanup_detects_a_new_entry_created_during_sanitizing(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        injected = False

        def inject_late_entry(path, flags, *args, **kwargs):
            nonlocal injected
            dir_fd = kwargs.get("dir_fd")
            descriptor = original_open(path, flags, *args, **kwargs)
            if path == "profile.json" and flags & os.O_WRONLY and not injected:
                injected = True
                late = original_open(
                    "late-value.bin",
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                    dir_fd=dir_fd,
                )
                os.write(late, b"late-valuable-bytes")
                os.close(late)
            return descriptor

        with mock.patch.object(self.cli.os, "open", side_effect=inject_late_entry):
            result = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(result, (2, None, "run cleanup failed\n"))
        self.assertEqual(
            (run_root / "late-value.bin").read_bytes(), b"late-valuable-bytes"
        )
        self.server_cleanup = None

    def test_cleanup_retries_after_interrupted_abandoned_marker_temp(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        original_write = self.cli.os.write
        marker_descriptor = None
        interrupted = False

        def remember_marker(path, flags, *args, **kwargs):
            nonlocal marker_descriptor
            descriptor = original_open(path, flags, *args, **kwargs)
            if isinstance(path, str) and path.startswith(".marker-abandoned-"):
                marker_descriptor = descriptor
            return descriptor

        def short_write(descriptor, data):
            nonlocal interrupted
            if descriptor == marker_descriptor and not interrupted:
                interrupted = True
                original_write(descriptor, data[:3])
                raise OSError("disk full")
            return original_write(descriptor, data)

        with mock.patch.object(
            self.cli.os, "open", side_effect=remember_marker
        ), mock.patch.object(self.cli.os, "write", side_effect=short_write):
            first = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(first, (2, None, "run artifact write failed\n"))
        temps = list(run_root.glob(".marker-abandoned-*.tmp"))
        self.assertEqual(len(temps), 1)
        self.assertGreater(temps[0].stat().st_size, 0)
        with mock.patch.object(
            self.cli.os, "unlink", side_effect=AssertionError("unlink called")
        ), mock.patch.object(
            self.cli.os, "rmdir", side_effect=AssertionError("rmdir called")
        ):
            code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
        self.assertEqual(temps[0].stat().st_size, 0)
        self.server_cleanup = None

    def test_cleanup_retries_after_interrupted_tombstone_marker_temp(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        original_write = self.cli.os.write
        marker_descriptor = None
        interrupted = False

        def remember_marker(path, flags, *args, **kwargs):
            nonlocal marker_descriptor
            descriptor = original_open(path, flags, *args, **kwargs)
            if isinstance(path, str) and path.startswith(".marker-tombstone-"):
                marker_descriptor = descriptor
            return descriptor

        def fail_tombstone(descriptor, data):
            nonlocal interrupted
            if descriptor == marker_descriptor and not interrupted:
                interrupted = True
                original_write(descriptor, data[:5])
                raise OSError("disk full")
            return original_write(descriptor, data)

        with mock.patch.object(
            self.cli.os, "open", side_effect=remember_marker
        ), mock.patch.object(self.cli.os, "write", side_effect=fail_tombstone):
            first = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(first, (2, None, "run artifact write failed\n"))
        temps = list(run_root.glob(".marker-tombstone-*.tmp"))
        self.assertEqual(len(temps), 1)
        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
        self.assertEqual(temps[0].stat().st_size, 0)
        self.server_cleanup = None

    def test_cleanup_reconstructs_partial_final_markers_from_anchored_state(self) -> None:
        for marker_name in ("abandoned.json", "tombstone.json"):
            with self.subTest(marker_name=marker_name):
                _output, run_root, _state = self.prepare()
                marker = run_root / marker_name
                marker.write_bytes(b'{"state":')
                os.chmod(marker, 0o600)

                code, result, stderr = self.invoke(
                    ["cleanup", "--run-id", run_root.name]
                )

                self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
                stored = json.loads((run_root / "tombstone.json").read_text())
                self.assertEqual({key: stored[key] for key in result}, result)
                for path in run_root.glob(".marker-*.tmp"):
                    self.assertEqual(path.stat().st_size, 0)
                self.server_cleanup = None

    def test_cleanup_recovers_after_every_sanitization_interruption(self) -> None:
        _probe_output, probe_root, _state = self.prepare()
        existing_regulars = sum(path.is_file() for path in probe_root.rglob("*"))
        self.invoke(["cleanup", "--run-id", probe_root.name])
        self.server_cleanup = None
        phases = existing_regulars + 2  # abandoned marker and evaluate lock
        self.assertGreater(phases, 3)

        for interrupt_after in range(1, phases + 1):
            with self.subTest(interrupt_after=interrupt_after):
                _output, run_root, _state = self.prepare()
                original_truncate = self.cli.os.ftruncate
                truncations = 0

                def interrupt_after_write(descriptor, size):
                    nonlocal truncations
                    truncations += 1
                    result = original_truncate(descriptor, size)
                    if truncations == interrupt_after:
                        raise OSError("interrupted sanitization")
                    return result

                with mock.patch.object(
                    self.cli.os, "ftruncate", side_effect=interrupt_after_write
                ):
                    first = self.invoke(["cleanup", "--run-id", run_root.name])

                self.assertEqual(first, (2, None, "run cleanup failed\n"))
                code, result, stderr = self.invoke(
                    ["cleanup", "--run-id", run_root.name]
                )
                self.assertEqual(
                    (code, result["state"], stderr), (0, "abandoned", "")
                )
                for path in run_root.rglob("*"):
                    if path.is_file() and path.name != "tombstone.json":
                        self.assertEqual(path.stat().st_size, 0, path)
                self.server_cleanup = None

    def test_expected_resume_contract_is_closed_and_required(self) -> None:
        expected_path = self.scenarios / SCENARIO_ID / "expected.json"
        expected = json.loads(expected_path.read_text())
        expected["resumeFilename"] = "wrong.pdf"
        expected_path.write_text(json.dumps(expected))

        code, output, stderr = self.invoke(
            ["prepare", "--fixture", FIXTURE_ID, "--scenario", SCENARIO_ID]
        )

        self.assertEqual((code, output, stderr), (2, None, "invalid scenario package\n"))
        self.assertFalse(self.runs.exists())

    def test_prepare_rejects_scenario_outside_closed_allowlist(self) -> None:
        code, output, stderr = self.invoke(
            ["prepare", "--fixture", FIXTURE_ID, "--scenario", "other-scenario"]
        )

        self.assertEqual(
            (code, output, stderr),
            (2, None, "invalid scenario identifier\n"),
        )
        self.assertFalse(self.runs.exists())

    def test_skills_document_mandatory_qa_root_routing(self) -> None:
        answer_memory = (ROOT / "skills/answer-memory/SKILL.md").read_text()
        job_apply = (ROOT / "skills/job-apply/SKILL.md").read_text()
        for document in (answer_memory, job_apply):
            self.assertIn("qa-replay.py", document)
            self.assertIn("--route-token", document)
            self.assertIn("--root", document)
            self.assertIn("before", document.lower())
            self.assertIn("#qa-route=<run-id>.<64-lowercase-hex-token>", document)
            self.assertIn("cleanup --run-id", document)
            self.assertIn("report", document.lower())
            self.assertIn("sanitized tombstone", document.lower())
            self.assertIn("never unlinks", document.lower())
        coordinator = SCRIPT.read_text()
        self.assertNotIn("os.kill(", coordinator)
        self.assertNotIn('["ps",', coordinator)


    def test_verify_auto_submit_is_repeatable_redacted_and_loopback_only(self):
        fixture = ROOT / "qa/fixtures/linkedin-easy-apply-screening-2026-08-v1/fixture.json"
        for _ in range(2):
            completed = __import__("subprocess").run(
                [
                    "python3",
                    str(SCRIPT),
                    "verify-auto-submit",
                    "--fixture",
                    str(fixture),
                    "--json",
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads(completed.stdout)
            self.assertEqual(report["status"], "passed")
            self.assertIs(report["redacted"], True)
            self.assertEqual(
                set(report["assertions"]),
                {
                    "actual-review-only-refused",
                    "all-stop-boundaries-zero-activations",
                    "concurrent-activation-single-winner",
                    "danger-warning-required",
                    "denials-and-receipts-redacted",
                    "forged-stale-prompt-redirect-kill-expiry-refused",
                    "independent-confirmation-required",
                    "kill-versus-activation-linearized",
                    "one-retry-terminal-exhaustion",
                    "review-only-zero-activations",
                    "success-one-claimed-activation",
                },
            )
            self.assertEqual(set(report["assertions"].values()), {"passed"})
            self.assertEqual(
                report["scenarios"]["success"]["claimedActivations"], 1
            )
            self.assertEqual(
                report["scenarios"]["uncertainty-retry"]["terminalState"],
                "uncertain_exhausted",
            )
            serialized = completed.stdout.casefold()
            for forbidden in ("http://", "https://", "answerrevision", "resume-v1"):
                self.assertNotIn(forbidden, serialized)


class CommittedScenarioTests(unittest.TestCase):
    def base_url(self, url: str) -> str:
        parsed = urlsplit(url)
        return f"{parsed.scheme}://{parsed.netloc}"

    def test_complete_profile_scenario_is_closed_and_synthetic(self) -> None:
        scenario_root = ROOT / "qa/scenarios/complete-profile"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())

        self.assertEqual(profile["name"], "Avery Replay")
        self.assertEqual(
            (profile["firstName"], profile["lastName"]),
            ("Avery", "Replay"),
        )
        self.assertRegex(profile["email"], r"^[a-z.]+@example\.com$")
        self.assertRegex(profile["phone"], r"^[2-9][0-9]{2}-555-01[0-9]{2}$")
        self.assertEqual(profile["location"]["city"], "Phoenix")
        self.assertEqual(profile["resumePath"], "synthetic-resume.pdf")
        for forbidden_key in (
            "workHistory",
            "education",
            "linkedInUrl",
            "portfolioUrl",
            "githubUrl",
        ):
            self.assertNotIn(forbidden_key, profile)

        self.assertEqual(
            expected,
            {
                "controlIds": [
                    "contact.first_name",
                    "contact.last_name",
                    "contact.email",
                    "contact.phone",
                    "resume.file",
                ],
                "resumeFilename": "synthetic-resume.pdf",
            },
        )
        serialized_expected = json.dumps(expected).casefold()
        for value in (
            profile["name"],
            profile["email"],
            profile["phone"],
            profile["location"]["city"],
        ):
            self.assertNotIn(value.casefold(), serialized_expected)

        extracted = validate_committed_synthetic_pdf(
            (scenario_root / "synthetic-resume.pdf").read_bytes()
        )
        for expected_text in (
            "AVERY REPLAY",
            "Fictional Applicant",
            "Phoenix, Arizona",
            "avery.replay@example.com",
            "602-555-0142",
            "Communication",
            "Organization",
            "Problem solving",
            "Attention to detail",
        ):
            self.assertIn(expected_text, extracted)

    def test_greenhouse_complete_profile_scenario_matches_committed_fixture(self) -> None:
        scenario_root = ROOT / "qa/scenarios/greenhouse-complete-profile"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())
        fixture = json.loads((
            ROOT / "qa/fixtures/greenhouse-single-page-2026-08-v1/fixture.json"
        ).read_text())
        fixture_control_ids = [
            control["id"]
            for step in fixture["steps"]
            for control in step["controls"]
        ]
        self.assertEqual(profile["name"], "Avery Replay")
        self.assertEqual(expected, {
            "controlIds": fixture_control_ids,
            "resumeFilename": "synthetic-resume.pdf",
        })
        self.assertEqual(
            (scenario_root / "synthetic-resume.pdf").read_bytes(),
            (ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf").read_bytes(),
        )

    def test_ashby_complete_profile_scenario_is_closed_and_synthetic(self) -> None:
        scenario_root = ROOT / "qa/scenarios/ashby-complete-profile"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())
        self.assertEqual(profile["name"], "Avery Replay")
        self.assertRegex(profile["email"], r"^[a-z.]+@example\.com$")
        self.assertEqual(profile["resumePath"], "synthetic-resume.pdf")
        self.assertEqual(expected, {
            "controlIds": ["contact.full_name", "contact.email", "resume.file"],
            "resumeFilename": "synthetic-resume.pdf",
        })
        self.assertEqual(
            (scenario_root / "synthetic-resume.pdf").read_bytes(),
            (ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf").read_bytes(),
        )

    def test_lever_complete_profile_scenario_is_closed_and_synthetic(self) -> None:
        scenario_root = ROOT / "qa/scenarios/lever-complete-profile"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())
        self.assertEqual(profile["name"], "Avery Replay")
        self.assertRegex(profile["email"], r"^[a-z.]+@example\.com$")
        self.assertEqual(profile["resumePath"], "synthetic-resume.pdf")
        self.assertEqual(
            expected["controlIds"],
            [
                "resume.file", "contact.full_name", "contact.email",
                "contact.phone", "contact.location", "employment.current_company",
                "profile.location_url", "profile.linkedin", "profile.github",
                "profile.portfolio", "profile.website",
                "authorization.work_authorized", "authorization.sponsorship_status",
                "source.discovery_radio", "compensation.total_range",
                "compensation.target_salary", "employment.prior_company",
                "conflict.related_person", "conflict.customer_partner_reseller",
                "location.us_resident", "location.city_state",
                "authorization.us_citizen", "authorization.green_card",
                "eeo.gender", "eeo.race", "eeo.veteran", "eeo.disability",
            ],
        )
        self.assertEqual(expected["resumeFilename"], "synthetic-resume.pdf")
        self.assertEqual(
            (scenario_root / "synthetic-resume.pdf").read_bytes(),
            (ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf").read_bytes(),
        )

    def test_linkedin_screening_scenario_is_closed_and_synthetic(self) -> None:
        scenario_root = ROOT / "qa/scenarios/linkedin-screening"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())
        self.assertEqual(profile["name"], "Avery Replay")
        self.assertRegex(profile["email"], r"^[a-z.]+@example\.com$")
        self.assertRegex(profile["phone"], r"^[2-9][0-9]{2}-555-01[0-9]{2}$")
        self.assertEqual(profile["resumePath"], "synthetic-resume.pdf")
        self.assertEqual(
            expected,
            {
                "controlIds": [
                    "contact.email",
                    "contact.phone",
                    "resume.file",
                    "preference.top_choice",
                    "authorization.sponsorship",
                ],
                "resumeFilename": "synthetic-resume.pdf",
            },
        )
        serialized_expected = json.dumps(expected).casefold()
        for value in (profile["name"], profile["email"], profile["phone"]):
            self.assertNotIn(value.casefold(), serialized_expected)
        self.assertEqual(
            (scenario_root / "synthetic-resume.pdf").read_bytes(),
            (ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf").read_bytes(),
        )

    def test_linkedin_screening_fresh_prepare_evaluate_cleanup_lifecycle(self) -> None:
        fixture_id = "linkedin-easy-apply-screening-2026-08-v1"
        scenario_id = "linkedin-screening"
        with tempfile.TemporaryDirectory() as directory:
            cli = load_cli()
            cli.FIXTURES_ROOT = ROOT / "qa/fixtures"
            cli.SCENARIOS_ROOT = ROOT / "qa/scenarios"
            cli.RUNS_ROOT = Path(directory) / "fresh-runs"

            prepared = cli._prepare(fixture_id, scenario_id)
            run_root = Path(prepared["storeRoot"]).parent
            report_path = run_root / "report.json"
            self.assertFalse(report_path.exists())
            state = json.loads((run_root / "run.json").read_text())
            fixture = json.loads((run_root / "fixture.json").read_text())
            profile = json.loads((run_root / "profile.json").read_text())
            applicant_values = {
                profile["name"],
                profile["firstName"],
                profile["lastName"],
                profile["email"],
                profile["phone"],
                *profile["location"].values(),
                *profile["skills"],
            }
            browser_answer_sentinels = {
                "qa-screening-browser@example.invalid",
                "480-555-0198",
                "No",
            }
            base_url = ReplayCoordinatorTests.base_url(self, prepared["url"])
            try:
                for step in fixture["steps"]:
                    for control in step["controls"]:
                        event = {
                            "type": (
                                "uploaded" if control["role"] == "file" else "filled"
                            ),
                            "controlId": control["id"],
                            "stepId": step["id"],
                        }
                        if control["role"] == "file":
                            event["expectedFilenameMatched"] = True
                        ReplayCoordinatorTests._post_event(self, prepared["url"], event)
                    ReplayCoordinatorTests._post_event(
                        self,
                        prepared["url"],
                        {
                            "type": (
                                "reviewed" if step["kind"] == "review" else "advanced"
                            ),
                            "controlId": "",
                            "stepId": step["id"],
                        },
                    )

                application_id = "linkedin-screening-application"
                history = [
                    {
                        "schemaVersion": 1,
                        "eventId": "screening-started",
                        "applicationId": application_id,
                        "event": "started",
                        "answerKeys": [],
                        "at": "2026-08-14T12:00:00Z",
                    },
                    {
                        "schemaVersion": 1,
                        "eventId": "screening-reviewed",
                        "applicationId": application_id,
                        "event": "reviewed",
                        "answerKeys": [],
                        "at": "2026-08-14T12:01:00Z",
                    },
                ]
                history_path = Path(prepared["storeRoot"]) / "applications.jsonl"
                history_path.write_text(
                    "".join(json.dumps(item) + "\n" for item in history)
                )
                os.chmod(history_path, 0o600)
                session_path = (
                    Path(prepared["storeRoot"]) / "sessions" / f"{application_id}.json"
                )
                session_path.write_text(
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "applicationId": application_id,
                            "status": "review",
                            "step": "review",
                            "answerKeys": [],
                            "pendingFields": [],
                            "createdAt": "2026-08-14T12:00:00Z",
                            "updatedAt": "2026-08-14T12:01:00Z",
                        }
                    )
                )
                os.chmod(session_path, 0o600)

                with urllib.request.urlopen(base_url + "/__qa/state", timeout=2) as response:
                    server_state = json.load(response)
                expected_ids = [
                    "contact.email",
                    "contact.phone",
                    "resume.file",
                    "preference.top_choice",
                    "authorization.sponsorship",
                ]
                self.assertEqual(
                    [
                        event["controlId"]
                        for event in server_state["events"]
                        if event["type"] in {"filled", "uploaded"}
                    ],
                    expected_ids,
                )
                self.assertEqual(server_state["finalActionActivations"], 0)
                visible_artifacts = json.dumps(server_state).casefold()
                allowed_event_keys = {
                    "filled": {"type", "controlId", "stepId"},
                    "uploaded": {
                        "type",
                        "controlId",
                        "stepId",
                        "expectedFilenameMatched",
                    },
                    "advanced": {"type", "controlId", "stepId"},
                    "reviewed": {"type", "controlId", "stepId"},
                }
                for event in server_state["events"]:
                    self.assertEqual(set(event), allowed_event_keys[event["type"]])
                for value in applicant_values:
                    self.assertNotIn(value.casefold(), visible_artifacts)
                for value in browser_answer_sentinels:
                    self.assertNotIn(json.dumps(value).casefold(), visible_artifacts)

                store_root = Path(prepared["storeRoot"])
                store_artifacts = {
                    path.relative_to(store_root).as_posix(): path.read_bytes()
                    for path in store_root.rglob("*")
                    if path.is_file()
                }
                self.assertEqual(
                    set(store_artifacts),
                    {
                        "answers.json",
                        "applications.jsonl",
                        "profile.json",
                        f"sessions/{application_id}.json",
                    },
                )
                serialized_store = (
                    b"\n".join(store_artifacts.values()).decode("utf-8").casefold()
                )
                for value in browser_answer_sentinels:
                    self.assertNotIn(json.dumps(value).casefold(), serialized_store)

                self.assertFalse(report_path.exists())
                code, report = cli._evaluate(run_root.name)
                self.assertEqual(code, 0)
                self.assertTrue(report_path.is_file())
                self.assertEqual(json.loads(report_path.read_text()), report)
                self.assertEqual(report["scenarioId"], scenario_id)
                self.assertEqual(report["status"], "passed")
                self.assertEqual(set(report["assertions"].values()), {"passed"})
                self.assertEqual(report["missingControlIds"], [])
                self.assertEqual(report["failureCategories"], [])
                serialized_report = json.dumps(report).casefold()
                for value in applicant_values:
                    self.assertNotIn(value.casefold(), serialized_report)
                for value in browser_answer_sentinels:
                    self.assertNotIn(json.dumps(value).casefold(), serialized_report)
                self.assertEqual(
                    report["assertions"]["final-action-untouched"], "passed"
                )

                cleanup = cli._cleanup(run_root.name)
                self.assertEqual(
                    cleanup,
                    {
                        "runId": run_root.name,
                        "state": "completed",
                        "reportRetained": True,
                    },
                )
                retained = {
                    path.relative_to(run_root).as_posix(): path.read_bytes()
                    for path in run_root.rglob("*")
                    if path.is_file()
                }
                nonempty_retained = {
                    path: payload for path, payload in retained.items() if payload
                }
                self.assertEqual(
                    set(nonempty_retained), {"report.json", "tombstone.json"}
                )
                for path, payload in retained.items():
                    if path not in nonempty_retained:
                        self.assertEqual(payload, b"")
                serialized_retained = (
                    b"\n".join(
                        nonempty_retained[path] for path in sorted(nonempty_retained)
                    )
                    .decode("utf-8")
                    .casefold()
                )
                for value in applicant_values:
                    self.assertNotIn(value.casefold(), serialized_retained)
                for value in browser_answer_sentinels:
                    self.assertNotIn(json.dumps(value).casefold(), serialized_retained)
                tombstone = json.loads(retained["tombstone.json"])
                self.assertEqual(tombstone["scenarioId"], scenario_id)
                self.assertEqual(cli._cleanup(run_root.name), cleanup)
            finally:
                try:
                    request = urllib.request.Request(
                        base_url + "/__qa/shutdown",
                        headers={"X-QA-Run-Token": state["shutdownToken"]},
                        method="POST",
                    )
                    urllib.request.urlopen(request, timeout=2).close()
                except (OSError, urllib.error.URLError):
                    pass

    def test_pdf_inspector_rejects_denied_text_active_content_and_pages(self) -> None:
        scenario_pdf = (
            ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf"
        ).read_bytes()
        injected = append_to_pdf_content(
            scenario_pdf,
            b"BT (Source Company) Tj ET",
        )
        with self.assertRaisesRegex(AssertionError, "denied text"):
            inspect_synthetic_pdf(injected)

        active = append_to_pdf_content(
            scenario_pdf,
            b"/Type /Action /S /JavaScript",
        )
        with self.assertRaisesRegex(AssertionError, "active PDF feature"):
            inspect_synthetic_pdf(active)

        hex_text = append_to_pdf_content(
            scenario_pdf,
            b"BT <536F7572636520436F6D70616E79> Tj ET",
        )
        with self.assertRaisesRegex(AssertionError, "hex string"):
            inspect_synthetic_pdf(hex_text)

        text_array = append_to_pdf_content(
            scenario_pdf,
            b"BT [(Source) 0 (Company)] TJ ET",
        )
        with self.assertRaisesRegex(AssertionError, "text array"):
            inspect_synthetic_pdf(text_array)

        unsupported_filter = scenario_pdf.replace(
            b"/Filter [ /FlateDecode ]",
            b"/Filter [ /ASCII85Decode ]",
            1,
        )
        self.assertNotEqual(unsupported_filter, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "content stream filter"):
            inspect_synthetic_pdf(unsupported_filter)

        unsupported_encoding = scenario_pdf.replace(
            b"/Encoding /WinAnsiEncoding",
            b"/Encoding /MacRomanEncoding",
            1,
        )
        self.assertNotEqual(unsupported_encoding, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "active PDF feature"):
            inspect_synthetic_pdf(unsupported_encoding)

        duplicate_kid = scenario_pdf.replace(
            b"/Kids [ 4 0 R ]",
            b"/Kids [ 4 0 R 4 0 R ]",
            1,
        )
        self.assertNotEqual(duplicate_kid, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "one unique page kid"):
            inspect_synthetic_pdf(duplicate_kid)

    def test_pdf_inspector_rejects_hidden_metadata_and_trailing_bytes(self) -> None:
        scenario_pdf = (
            ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf"
        ).read_bytes()
        for original, replacement in (
            (b"(Fictional QA Applicant)", b"(Source Company)"),
            (b"(Fictional QA Applicant)", b"(Private Person)"),
            (b"(Synthetic Resume)", b"(Hidden Value)"),
            (b"(Synthetic profile fixture)", b"(Confidential Value)"),
        ):
            with self.subTest(replacement=replacement):
                tampered = scenario_pdf.replace(original, replacement, 1)
                self.assertNotEqual(tampered, scenario_pdf)
                with self.assertRaisesRegex(AssertionError, "Info dictionary value"):
                    inspect_synthetic_pdf(tampered)

        xmp = scenario_pdf.replace(
            b"trailer\n",
            b"99 0 obj\n<< /Type /Metadata /Subtype /XML >>\nendobj\ntrailer\n",
            1,
        )
        self.assertNotEqual(xmp, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "active PDF feature"):
            inspect_synthetic_pdf(xmp)

        extra_info = scenario_pdf.replace(
            b"trailer\n",
            b"99 0 obj\n<< /Author (Fictional QA Applicant) >>\nendobj\ntrailer\n",
            1,
        )
        self.assertNotEqual(extra_info, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "extra metadata dictionary"):
            inspect_synthetic_pdf(extra_info)

        hidden_comment = scenario_pdf.replace(
            b"trailer\n",
            b"% Source Company\ntrailer\n",
            1,
        )
        with self.assertRaisesRegex(AssertionError, "denied text"):
            inspect_synthetic_pdf(hidden_comment)

        for trailing in (
            b"% https://private.invalid\n",
            b"% hidden comment\n",
            b"unexpected bytes",
        ):
            with self.subTest(trailing=trailing):
                with self.assertRaisesRegex(AssertionError, "physical EOF"):
                    inspect_synthetic_pdf(scenario_pdf + trailing)

    def test_reviewed_digest_rejects_arbitrary_catalog_and_page_names(self) -> None:
        scenario_pdf = (
            ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf"
        ).read_bytes()
        for original, replacement in (
            (
                b"/PageMode /UseNone",
                b"/PageMode /UseNone /HiddenCatalogName /HiddenValue",
            ),
            (
                b"/Rotate 0",
                b"/Rotate 0 /HiddenPageName /HiddenValue",
            ),
        ):
            with self.subTest(replacement=replacement):
                tampered = scenario_pdf.replace(original, replacement, 1)
                self.assertNotEqual(tampered, scenario_pdf)
                with self.assertRaisesRegex(AssertionError, "digest changed"):
                    validate_committed_synthetic_pdf(tampered)

    def test_committed_scenario_prepares_real_store_without_http_leak(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture_dir = root / "fixtures" / FIXTURE_ID
            fixture_dir.mkdir(parents=True)
            capture = json.loads((PRIVATE_CAPTURE / "semantic.json").read_text())
            receipt = json.loads(
                (PRIVATE_CAPTURE / "capture-receipt.json").read_text()
            )
            fixture = compile_capture(capture, receipt, FIXTURE_ID)
            (fixture_dir / "fixture.json").write_text(json.dumps(fixture))

            cli = load_cli()
            cli.FIXTURES_ROOT = root / "fixtures"
            cli.SCENARIOS_ROOT = ROOT / "qa/scenarios"
            cli.RUNS_ROOT = root / "runs"
            prepared = cli._prepare(FIXTURE_ID, SCENARIO_ID)
            run_root = Path(prepared["storeRoot"]).parent
            state = json.loads((run_root / "run.json").read_text())
            try:
                profile = json.loads(
                    (run_root / "store/profile.json").read_text()
                )["profile"]
                committed_profile = json.loads(
                    (ROOT / "qa/scenarios/complete-profile/profile.json").read_text()
                )
                expected_profile = dict(committed_profile)
                expected_profile["resumePath"] = str(
                    (run_root / "synthetic-resume.pdf").resolve()
                )
                self.assertEqual(profile, expected_profile)

                base_url = ReplayCoordinatorTests.base_url(self, prepared["url"])
                responses = []
                for path in ("/", "/__qa/fixture", "/__qa/state"):
                    with urllib.request.urlopen(base_url + path, timeout=2) as response:
                        responses.append(response.read().decode("utf-8"))
                visible_http = "\n".join(responses).casefold()
                for private_value in (
                    committed_profile["name"],
                    committed_profile["email"],
                    committed_profile["phone"],
                    committed_profile["location"]["city"],
                ):
                    self.assertNotIn(private_value.casefold(), visible_http)
            finally:
                request = urllib.request.Request(
                    ReplayCoordinatorTests.base_url(self, prepared["url"])
                    + "/__qa/shutdown",
                    headers={"X-QA-Run-Token": state["shutdownToken"]},
                    method="POST",
                )
                urllib.request.urlopen(request, timeout=2).close()


if __name__ == "__main__":
    unittest.main()
