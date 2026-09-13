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


ROOT = Path(__file__).resolve().parents[2]
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
