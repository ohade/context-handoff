#!/usr/bin/env python3
"""Check a compaction snapshot against the shared snapshot template (contract C2).

Usage: check-snapshot.py <snapshot> [--template <path>]

The header keys and the required headings are read from the template, never hard-coded.
Exit 0: valid. Exit 1: invalid, one line per problem on stderr. Exit 2: unreadable input
(snapshot or template), or a template that does not define the C2 structure.
"""

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_TEMPLATE = Path(__file__).resolve().parent.parent / "reference" / "snapshot-template.md"

HEADER_OPEN = "<!-- header -->"
HEADER_CLOSE = "<!-- /header -->"
HEADER_KEY_RE = re.compile(r"^([a-z]+): ")
HEADING_RE = re.compile(r"^## \d+\. .+$")
LEVEL2_RE = re.compile(r"^## ")
FACTS_HEADING = "## Facts from the transcript"
STATUS_SECTION_RE = re.compile(r"^## 8\. ")
STATUS_VALID_RE = re.compile(r"^Status: (answered|partial|not answered)$")
STATUS_ANY_RE = re.compile(r"^\s*Status:")
SHORT_ID_RE = re.compile(r"^[0-9A-Za-z]{8}$")
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
PLACEHOLDER_RE = re.compile(r"^<.*>$")
HEADER_SCAN_LINES = 15
# <session-id>-<YYYYMMDD-HHMM>[-<n>].md; the optional -<n> cycle suffix keeps two runs in one minute apart.
SNAPSHOT_NAME_RE = re.compile(r"^(?P<session>.+)-\d{8}-\d{4}(?:-[1-9]\d*)?\.md$")


class InputError(Exception):
    """The snapshot or the template cannot be read or parsed."""


def read_lines(path):
    try:
        # Review cc M15: split on newlines only, as the mod does; splitlines() also splits on U+2028.
        return Path(path).read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")
    except (OSError, UnicodeDecodeError) as exc:
        raise InputError(f"cannot read {path}: {exc}") from exc


def parse_template(path):
    """Return (header_keys, headings, status_heading) as defined by the template."""
    lines = read_lines(path)
    try:
        start = lines.index(HEADER_OPEN)
        end = lines.index(HEADER_CLOSE, start + 1)
    except ValueError as exc:
        raise InputError(f"template {path}: missing {HEADER_OPEN} ... {HEADER_CLOSE} block") from exc

    keys = [m.group(1) for line in lines[start + 1:end] if (m := HEADER_KEY_RE.match(line))]
    headings = [line for line in lines if HEADING_RE.match(line)]
    status_headings = [h for h in headings if STATUS_SECTION_RE.match(h)]

    if not keys:
        raise InputError(f"template {path}: no header keys")
    if not headings:
        raise InputError(f"template {path}: no '## N. Title' headings")
    if len(status_headings) != 1:
        raise InputError(f"template {path}: expected one section 8 heading, found {len(status_headings)}")
    return keys, headings, status_headings[0]


def check_header(lines, keys):
    problems = []
    head = lines[:HEADER_SCAN_LINES]
    for key in keys:
        prefix = f"{key}:"
        found = [line for line in head if line.startswith(prefix)]
        if any(not line.startswith(prefix + " ") for line in found):
            problems.append(f"header: '{key}:' must be written as '{key}: <value>'")
            continue
        if not found:
            problems.append(f"header: missing '{key}:' in the first {HEADER_SCAN_LINES} lines")
            continue
        if len(found) > 1:
            problems.append(f"header: '{key}:' appears {len(found)} times in the first {HEADER_SCAN_LINES} lines")
            continue
        value = found[0][len(prefix):].strip()
        if not value:
            problems.append(f"header: '{key}:' has an empty value")
        elif PLACEHOLDER_RE.match(value):
            problems.append(f"header: '{key}:' still holds the template placeholder {value}")
        elif key == "session" and SHORT_ID_RE.match(value):
            problems.append(f"header: session '{value}' is an 8-character short id; use the full session id")
        elif key == "session" and not UUID_RE.match(value):
            problems.append(f"header: session '{value}' is not a full session id (UUID)")
    return problems


def header_value(lines, key):
    prefix = f"{key}:"
    found = [line[len(prefix):].strip() for line in lines[:HEADER_SCAN_LINES] if line.startswith(prefix)]
    return found[0] if len(found) == 1 else None


def check_file_name(snapshot, lines):
    """Check the session id in a snapshot-shaped file name; other names are not snapshot files."""
    match = SNAPSHOT_NAME_RE.match(Path(snapshot).name)
    if not match:
        return []
    name_session = match.group("session")
    if SHORT_ID_RE.match(name_session):
        return [f"file name: session '{name_session}' is an 8-character short id; use the full session id"]
    header_session = header_value(lines, "session")
    if header_session and name_session != header_session:
        return [f"file name: session '{name_session}' does not match header session '{header_session}'"]
    return []


def check_headings(lines, headings):
    problems = []
    positions = []
    for heading in headings:
        if lines.count(heading) > 1:
            problems.append(f"heading appears {lines.count(heading)} times: {heading}")
        if heading in lines:
            positions.append((lines.index(heading), heading))
        else:
            problems.append(f"heading missing or not verbatim: {heading}")
    previous = None
    for index, heading in positions:
        if previous is not None and index < previous[0]:
            problems.append(f"heading out of order: '{heading}' comes before '{previous[1]}'")
        previous = (index, heading)
    # Review cc M1 (2026-10-20): an invented '## ' heading ended section 3 early and hid
    # pending records from the Track preflight. Only the template headings and the
    # extractor's Facts heading may open a level-2 section.
    allowed = set(headings) | {FACTS_HEADING}
    problems.extend(
        f"unexpected heading: {line}" for line in lines if LEVEL2_RE.match(line) and line not in allowed
    )
    return problems


def check_status(lines, status_heading):
    if status_heading not in lines:
        return [f"status: cannot check, section heading missing: {status_heading}"]
    start = lines.index(status_heading) + 1
    end = next((i for i in range(start, len(lines)) if LEVEL2_RE.match(lines[i])), len(lines))
    section = lines[start:end]

    valid = [line for line in section if STATUS_VALID_RE.match(line)]
    invalid = [line for line in section if STATUS_ANY_RE.match(line) and not STATUS_VALID_RE.match(line)]
    problems = [
        f"status: invalid line '{line.strip()}'; use 'Status: answered|partial|not answered'"
        for line in invalid
    ]
    if not valid and not invalid:
        problems.append("status: section 8 has no 'Status: answered|partial|not answered' line")
    elif len(valid) > 1:
        problems.append(f"status: section 8 has {len(valid)} Status lines; exactly one is allowed")
    return problems


def check_snapshot(snapshot, template):
    keys, headings, status_heading = parse_template(template)
    lines = read_lines(snapshot)
    return (
        check_header(lines, keys)
        + check_file_name(snapshot, lines)
        + check_headings(lines, headings)
        + check_status(lines, status_heading)
        + check_pending(lines, headings)
        + check_guidance(lines, template)
    )


def check_guidance(lines, template):
    """Review cc M10 (2026-10-20): a section left as its italic template guidance passed."""
    guidance = {line for line in read_lines(template) if line.startswith("*") and line.endswith("*") and len(line) > 2}
    return [f"template guidance left unfilled: {line[:60]}" for line in lines if line in guidance]


def _no_repeated_keys(pairs):
    """Review cc M8: json.loads keeps only the last value of a repeated key; refuse instead."""
    keys = [key for key, _ in pairs]
    repeated = sorted({key for key in keys if keys.count(key) > 1})
    if repeated:
        raise ValueError(f"repeated key {', '.join(repeated)}")
    return dict(pairs)


def check_pending(lines, headings):
    """CC-181 (2026-10-10): prose pending items had no Track rows after handoff.

    Check the declared records only. The mod checks their actual paused/waiting rows
    through the public final checkpoint; this checker never reads Track storage.
    """
    heading = next((h for h in headings if h.startswith("## 3. ")), None)
    if heading not in lines:
        return []  # The heading check already reports this structural error.
    start = lines.index(heading) + 1
    end = next((i for i in range(start, len(lines)) if LEVEL2_RE.match(lines[i])), len(lines))
    outside = [line for index, line in enumerate(lines)
               if not start <= index < end and line.strip().startswith("- Pending:")]
    if outside:
        return ["pending: '- Pending:' record outside section 3"]
    section = [line.strip() for line in lines[start:end] if line.strip()]
    if section == ["- none"]:
        return []
    if not section:
        return ["pending: use '- none' or one '- Pending: <JSON record>' per item"]
    seen = set()
    problems = []
    for line in section:
        if not line.startswith("- Pending: "):
            problems.append("pending: use one '- Pending: <JSON record>' per item; never combine decisions in prose")
            continue
        try:
            item = json.loads(line[len("- Pending: "):], object_pairs_hook=_no_repeated_keys)
        except (json.JSONDecodeError, ValueError) as exc:
            problems.append(f"pending: invalid JSON record: {exc}")
            continue
        required = {"track_id", "subject", "note", "unblock"}
        if not isinstance(item, dict) or set(item) not in (required, required | {"status"}):
            problems.append("pending: each record needs track_id, subject, note and unblock, optionally status, and no other keys")
            continue
        if "status" in item and item["status"] not in ("paused", "waiting"):
            problems.append("pending: status must be paused or waiting")
        if any(not isinstance(item[key], str) or not item[key].strip() for key in ("subject", "note", "unblock")):
            problems.append("pending: subject, note and unblock must be nonempty strings")
        track_id = item["track_id"]
        if track_id is not None and (not isinstance(track_id, str) or not re.fullmatch(r"(?:plan|task|todo|restored:task):(?=\S)[^\r\n]+", track_id)):
            problems.append("pending: track_id must be a real Track tool id, or null when Track is absent")
        elif track_id is not None and track_id in seen:
            problems.append(f"pending: duplicate Track reference {track_id}")
        seen.add(track_id)
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check a compaction snapshot against the C2 template.")
    parser.add_argument("snapshot")
    parser.add_argument("--template", default=str(DEFAULT_TEMPLATE))
    args = parser.parse_args(argv)
    try:
        problems = check_snapshot(args.snapshot, args.template)
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
