#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINK_TEMP_FILE="$(mktemp "${TMPDIR:-/tmp}/job-apply-links.XXXXXX")"

cleanup() {
  rm -f -- "$LINK_TEMP_FILE"
}
trap cleanup EXIT

python3 - "$REPO_ROOT" > "$LINK_TEMP_FILE" <<'PY'
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

root = Path(sys.argv[1])
sources = (root / "README.md", root / "site/index.html")

class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets = []
        self.ids = set()

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if "id" in values:
            self.ids.add(values["id"])
        if "name" in values:
            self.ids.add(values["name"])
        for key in ("href", "src"):
            if key in values:
                kind = "link" if key == "href" else "asset"
                self.targets.append((kind, values[key]))

remote = set()
errors = []

for source in sources:
    text = source.read_text()
    if source.suffix == ".md":
        image_pattern = r"!\[[^\]]*\]\(([^\s)]+)\)"
        targets = [
            ("asset", target)
            for target in re.findall(image_pattern, text)
        ]
        text_without_images = re.sub(image_pattern, "", text)
        targets.extend(
            ("link", target)
            for target in re.findall(r"\[[^\]]*\]\(([^\s)]+)", text_without_images)
        )
        ids = set()
    else:
        parser = Links()
        parser.feed(text)
        targets = parser.targets
        ids = parser.ids

    for kind, target in targets:
        target = target.strip("<>")
        parsed = urlsplit(target)
        if parsed.scheme in {"http", "https"}:
            # Remote images and badges are cosmetic and often served by flaky CDNs.
            # Continue validating local assets and all navigational links.
            if kind == "link":
                remote.add(target)
            continue
        if parsed.scheme or target.startswith("//"):
            continue
        if not parsed.path:
            if parsed.fragment and parsed.fragment not in ids:
                errors.append(f"{source.relative_to(root)}: missing anchor #{parsed.fragment}")
            continue
        destination = (source.parent / unquote(parsed.path)).resolve()
        try:
            destination.relative_to(root.resolve())
        except ValueError:
            errors.append(f"{source.relative_to(root)}: target escapes repository: {target}")
            continue
        if not destination.exists():
            errors.append(f"{source.relative_to(root)}: missing local target: {target}")

if errors:
    raise SystemExit("\n".join(errors))

print("\n".join(sorted(remote)))
PY

echo "Local link targets passed"

while IFS= read -r url; do
  [ -n "$url" ] || continue
  status="$(curl --head --location --max-redirs 3 --connect-timeout 5 --max-time 15 \
    --retry 1 --retry-delay 1 --user-agent 'job-apply-plugin-link-check/1.0' \
    --silent --show-error --output /dev/null --write-out '%{http_code}' "$url" || true)"
  case "$status" in
    2??|3??|401|403|405|429)
      echo "Remote link reachable ($status): $url"
      ;;
    *)
      echo "Remote link failed ($status): $url" >&2
      exit 1
      ;;
  esac
done < "$LINK_TEMP_FILE"

echo "Link checks passed"
