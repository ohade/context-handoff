#!/usr/bin/env python3
"""Print the next free snapshot path and the created value for a compaction snapshot.

Usage: snapshot-path.py --session <full-session-id> [--dir <dir>]

Prints two lines:
  path=<dir>/<session>-<YYYYMMDD-HHMM>-<n>.md   (n = first number with no existing file)
  created=<local ISO 8601 with offset>
Creates <dir> if it is missing; never writes the snapshot itself. Exit 2 for a short or unsafe
session id, or a directory that cannot be created.
"""

import argparse
import datetime
import os
import re
import sys
from pathlib import Path

DEFAULT_DIR = Path(os.environ.get("CONTEXT_HANDOFF_BRIEF_DIR") or Path.home() / ".claude" / "state" / "compact-handoffs")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
SHORT_ID_RE = re.compile(r"^[0-9A-Za-z]{8}$")


def session_id_problem(session):
    if not SAFE_ID_RE.match(session):
        return f"unsafe session id {session!r}: use letters, digits, '-' or '_' only"
    if SHORT_ID_RE.match(session):
        return f"session '{session}' is an 8-character short id; use the full session id"
    return None


def next_free_path(directory, session, now):
    base = f"{session}-{now.strftime('%Y%m%d-%H%M')}"
    number = 1
    while (directory / f"{base}-{number}.md").exists():
        number += 1
    return directory / f"{base}-{number}.md"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Print the next free snapshot path and created value.")
    parser.add_argument("--session", required=True, help="full session id")
    parser.add_argument("--dir", default=str(DEFAULT_DIR), help=f"snapshot folder (default {DEFAULT_DIR})")
    args = parser.parse_args(argv)

    problem = session_id_problem(args.session)
    if problem:
        print(f"error: {problem}", file=sys.stderr)
        return 2

    directory = Path(args.dir).expanduser()
    # Review cc M11 (2026-10-20): snapshots hold full prompts, so new folders are private (0700).
    # Path.mkdir ignores `mode` for parents; the umask covers every folder it creates.
    previous_umask = os.umask(0o077)
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"error: cannot create {directory}: {exc}", file=sys.stderr)
        return 2
    finally:
        os.umask(previous_umask)

    now = datetime.datetime.now().astimezone()
    print(f"path={next_free_path(directory, args.session, now)}")
    print(f"created={now.isoformat(timespec='seconds')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
