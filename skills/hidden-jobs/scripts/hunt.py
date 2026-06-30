#!/usr/bin/env python3
"""
hidden-jobs fetcher — queries auth-free "hidden market" channels and emits
normalized job records as JSON to stdout. No third-party deps (urllib only).

Channels:
  - ATS public board APIs: Greenhouse, Lever, Ashby (small-company goldmine)
  - Niche aggregators: RemoteOK, Remotive, WeWorkRemotely (RSS)
  - Reddit hiring threads: r/forhire, r/remotejs, r/hiring (JSON API)

Social channels (LinkedIn posts, Twitter/X) are handled by the skill via
Chrome MCP, not here — they need an authenticated browser.

Usage:
  python3 hunt.py --channels ats,aggregators,reddit --since-days 30
  python3 hunt.py --profile ~/.claude-job-profile.json

Reads ATS company tokens + keywords from the profile's preferences block.
Prints a JSON object: {"jobs": [...], "errors": [...], "counts": {...}}
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from html.parser import HTMLParser
from xml.etree import ElementTree

UA = "Mozilla/5.0 (hidden-jobs/1.0; +https://github.com/neonwatty/job-apply-plugin)"
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
TAG_RE = re.compile(r"<[^>]+>")


def get(url, timeout=20, as_json=True):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read().decode("utf-8", "replace")
    return json.loads(data) if as_json else data


def strip_html(s):
    if not s:
        return ""
    s = TAG_RE.sub(" ", s)
    s = re.sub(r"&amp;", "&", s)
    s = re.sub(r"&lt;", "<", s)
    s = re.sub(r"&gt;", ">", s)
    s = re.sub(r"&#\d+;", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def find_email(*texts):
    for t in texts:
        if not t:
            continue
        m = EMAIL_RE.search(t)
        if m:
            # skip obvious noise
            e = m.group(0)
            if not e.lower().endswith((".png", ".jpg", ".gif", ".svg")):
                return e
    return None


def is_remote(*texts):
    blob = " ".join(t.lower() for t in texts if t)
    return any(k in blob for k in ("remote", "anywhere", "worldwide", "work from home"))


def rec(source, company, title, location, remote, salary, url, email, posted, desc):
    return {
        "source": source,
        "company": company or "",
        "title": (title or "").strip(),
        "location": location or "",
        "remote": bool(remote),
        "salary": salary or "",
        "url": url or "",
        "email": email or "",
        "posted": posted or "",
        "description": (strip_html(desc) or "")[:600],
    }


# ---------- ATS board APIs ----------
def fetch_greenhouse(token, errors):
    out = []
    try:
        data = get(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true")
        for j in data.get("jobs", []):
            loc = (j.get("location") or {}).get("name", "")
            content = j.get("content", "")
            out.append(rec("greenhouse", token, j.get("title"), loc,
                           is_remote(loc, content), "", j.get("absolute_url"),
                           find_email(content), j.get("updated_at", ""), content))
    except Exception as e:
        errors.append(f"greenhouse:{token}: {e}")
    return out


def fetch_lever(token, errors):
    out = []
    try:
        data = get(f"https://api.lever.co/v0/postings/{token}?mode=json")
        for j in data:
            cat = j.get("categories", {}) or {}
            loc = cat.get("location", "")
            desc = j.get("descriptionPlain") or j.get("description", "")
            out.append(rec("lever", token, j.get("text"), loc,
                           is_remote(loc, j.get("workplaceType", ""), desc), "",
                           j.get("hostedUrl"), find_email(desc),
                           "", desc))
    except Exception as e:
        errors.append(f"lever:{token}: {e}")
    return out


def fetch_ashby(token, errors):
    out = []
    try:
        data = get(f"https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true")
        for j in data.get("jobs", []):
            loc = j.get("location", "")
            desc = j.get("descriptionPlain") or ""
            comp = j.get("compensation") or {}
            salary = ""
            try:
                tiers = comp.get("compensationTierSummary", "")
                salary = tiers or ""
            except Exception:
                pass
            out.append(rec("ashby", token, j.get("title"), loc,
                           bool(j.get("isRemote")) or is_remote(loc, desc), salary,
                           j.get("jobUrl") or j.get("applyUrl"), find_email(desc),
                           j.get("publishedAt", ""), desc))
    except Exception as e:
        errors.append(f"ashby:{token}: {e}")
    return out


# ---------- Niche aggregators ----------
def fetch_remoteok(errors):
    out = []
    try:
        data = get("https://remoteok.com/api")
        for j in data:
            if not isinstance(j, dict) or "position" not in j:
                continue
            desc = j.get("description", "")
            out.append(rec("remoteok", j.get("company"), j.get("position"),
                           j.get("location", "Remote"), True,
                           f"${j.get('salary_min','')}-${j.get('salary_max','')}" if j.get("salary_min") else "",
                           j.get("url"), find_email(desc), j.get("date", ""), desc))
    except Exception as e:
        errors.append(f"remoteok: {e}")
    return out


def fetch_remotive(errors):
    out = []
    try:
        data = get("https://remotive.com/api/remote-jobs?limit=200")
        for j in data.get("jobs", []):
            desc = j.get("description", "")
            out.append(rec("remotive", j.get("company_name"), j.get("title"),
                           j.get("candidate_required_location", "Remote"), True,
                           j.get("salary", ""), j.get("url"), find_email(desc),
                           j.get("publication_date", ""), desc))
    except Exception as e:
        errors.append(f"remotive: {e}")
    return out


def fetch_wwr(errors):
    out = []
    try:
        xml = get("https://weworkremotely.com/categories/remote-programming-jobs.rss", as_json=False)
        root = ElementTree.fromstring(xml)
        for item in root.iter("item"):
            title = (item.findtext("title") or "")
            company, role = (title.split(":", 1) + [""])[:2] if ":" in title else ("", title)
            desc = item.findtext("description") or ""
            link = item.findtext("link") or ""
            out.append(rec("weworkremotely", company.strip(), role.strip(),
                           "Remote", True, "", link, find_email(desc),
                           item.findtext("pubDate", ""), desc))
    except Exception as e:
        errors.append(f"weworkremotely: {e}")
    return out


# ---------- Reddit hiring threads ----------
def fetch_reddit(errors, subs=("forhire", "remotejs", "hiring")):
    out = []
    for sub in subs:
        try:
            data = get(f"https://www.reddit.com/r/{sub}/search.json?q=hiring&restrict_sr=1&sort=new&limit=50")
            for child in data.get("data", {}).get("children", []):
                p = child.get("data", {})
                title = p.get("title", "")
                # r/forhire convention: [Hiring] posts are employers seeking
                if "[hiring]" not in title.lower() and "hiring" not in title.lower():
                    continue
                body = p.get("selftext", "")
                out.append(rec("reddit/" + sub, "", title, "", is_remote(title, body),
                               "", "https://www.reddit.com" + p.get("permalink", ""),
                               find_email(title, body), str(p.get("created_utc", "")), body))
            time.sleep(0.5)
        except Exception as e:
            errors.append(f"reddit/{sub}: {e}")
    return out


def main():
    ap = argparse.ArgumentParser()
    # reddit excluded by default: reddit blocks datacenter IPs (403), so the
    # skill fetches Reddit threads via WebFetch / Chrome MCP instead. Pass
    # --channels reddit explicitly to attempt it from here anyway.
    ap.add_argument("--channels", default="ats,aggregators")
    ap.add_argument("--profile", default=os.path.expanduser("~/.claude-job-profile.json"))
    ap.add_argument("--since-days", type=int, default=30)
    args = ap.parse_args()

    prefs = {}
    try:
        with open(args.profile) as f:
            prefs = json.load(f).get("preferences", {})
    except Exception:
        pass

    tokens = prefs.get("atsCompanyTokens", {}) or {}
    channels = set(c.strip() for c in args.channels.split(","))
    jobs, errors = [], []

    if "ats" in channels:
        for t in tokens.get("greenhouse", []):
            jobs += fetch_greenhouse(t, errors)
        for t in tokens.get("lever", []):
            jobs += fetch_lever(t, errors)
        for t in tokens.get("ashby", []):
            jobs += fetch_ashby(t, errors)

    if "aggregators" in channels:
        jobs += fetch_remoteok(errors)
        jobs += fetch_remotive(errors)
        jobs += fetch_wwr(errors)

    if "reddit" in channels:
        jobs += fetch_reddit(errors)

    # dedup on (company|title|url)
    seen, deduped = set(), []
    for j in jobs:
        key = (j["company"].lower().strip(), j["title"].lower().strip(), j["url"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(j)

    counts = {}
    for j in deduped:
        src = j["source"].split("/")[0]
        counts[src] = counts.get(src, 0) + 1

    print(json.dumps({
        "jobs": deduped,
        "errors": errors,
        "counts": counts,
        "total": len(deduped),
        "with_email": sum(1 for j in deduped if j["email"]),
    }, indent=2))


if __name__ == "__main__":
    main()
