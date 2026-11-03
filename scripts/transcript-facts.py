#!/usr/bin/env python3
"""Extract the facts a fresh context needs from a Claude Code transcript (contract C1).

Usage:
    transcript-facts.py <transcript.jsonl> [--json|--markdown] [--no-subagents]
                        [--exclude-prompt TEXT]... [--exclude-prefix TEXT]...
                        [--user-requests]

Reads the main JSONL transcript line by line, plus the subagent transcripts in
<transcript-dir>/<session-id>/subagents/*.jsonl unless --no-subagents. Reports files
edited, git commits, ticket keys and the last real typed user prompt.

Exit codes: 0 success; 2 transcript missing, unreadable or without any valid JSONL
record; 1 any other failure (including usage errors). Errors go to stderr.
Standard library only; no network, no subprocess.
"""

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone

# A project key alone cannot identify its tracking system. Keep generic uppercase keys;
# explicit repository and issue references below retain their GitHub source.
GITHUB_SYSTEM = "github"

EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
CAPS = {"files": 40, "commits": 30, "tickets": 20}

# Prompt text that a hook, the harness or an automation injected as a "user" record.
INJECTED_PREFIXES = (
    "<command-name>", "<command-message>", "<command-args>",
    "<local-command-", "<task-notification>", "<teammate-message",
    "<user-prompt-submit-hook>", "Caveat:",
    # `!` shell-mode rows: the command and its output, recorded with no `origin` key.
    "<bash-input>", "<bash-stdout>", "<bash-stderr>",
    "Another Claude session sent a message",
    "[Request interrupted by user",
    "This session is being continued from a previous conversation",
    ": AMQ doorbell",
    # The context-handoff mod's model-only row (fixed opening, pinned in its seed-row.spec.ts).
    "The handoff brief is at ",
)

TRACKED_KEY_RE = re.compile(
    r"(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]*)-(\d+)(?![A-Za-z0-9_-])"
)
GITHUB_REPO_RE = re.compile(
    r"(?<![\w./-])([A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+)#(\d+)\b"
)
GITHUB_WORD_RE = re.compile(r"\b(PR|pull|issue)\s?#(\d+)\b", re.IGNORECASE)
COMMIT_LINE_RE = re.compile(
    r"^\[(?P<branch>[^\]\n]+?)(?: \(root-commit\))? (?P<sha>[0-9a-f]{7,40})\] "
    r"(?P<subject>[^\n]+)$",
    re.MULTILINE,
)
COMMAND_NAME_RE = re.compile(r"<command-name>\s*([^<\s]+)\s*</command-name>")
COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.DOTALL)
SYSTEM_REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)


class TranscriptError(Exception):
    """The main transcript is missing, unreadable or holds no valid record (exit 2)."""


class UsageParser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"{self.prog}: error: {message}", file=sys.stderr)
        sys.exit(1)


def iter_records(path, strict, on_skip=lambda: None):
    """Yield JSON-object records from a JSONL file, one line at a time.

    A line that is not a JSON object is skipped and reported through ``on_skip``: a live
    transcript's torn last line is expected, a corrupt line mid-file is not; both are counted.
    """
    valid = 0
    try:
        with open(path, "rb") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    on_skip()
                    continue
                if not isinstance(record, dict):
                    on_skip()
                    continue
                valid += 1
                yield record
    except OSError as exc:
        if strict:
            raise TranscriptError(f"cannot read {path}: {exc.strerror or exc}") from exc
        print(f"transcript-facts: skipping {path}: {exc}", file=sys.stderr)
        return
    if strict and valid == 0:
        raise TranscriptError(f"no valid JSONL record in {path}")


def content_parts(record):
    message = record.get("message")
    if not isinstance(message, dict):
        return None
    return message.get("content")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def has_tool_result(content):
    return isinstance(content, list) and any(
        isinstance(part, dict) and part.get("type") == "tool_result" for part in content
    )


def strings_in(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings_in(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings_in(item)


def collapse_whitespace(text):
    """Trim and collapse every run of whitespace to one space (exclusion matching only)."""
    return " ".join(text.split())


def real_prompt_text(record):
    """Return the typed prompt text of a real user record, or None for anything injected."""
    if record.get("type") != "user" or record.get("isMeta") or record.get("isCompactSummary"):
        return None
    content = content_parts(record)
    if has_tool_result(content):
        return None
    origin = record.get("origin")
    typed_by_human = isinstance(origin, dict) and origin.get("kind") == "human"
    if "origin" in record and not typed_by_human:
        return None
    text = SYSTEM_REMINDER_RE.sub("", text_of(content)).strip()
    if typed_by_human:
        command = COMMAND_NAME_RE.search(text)
        if command and text.startswith(("<command-name>", "<command-message>")):
            args = COMMAND_ARGS_RE.search(text)
            args_text = args.group(1).strip() if args else ""
            name = command.group(1)
            name = name if name.startswith("/") else "/" + name
            return f"{name} {args_text}" if args_text else name
    if not text or text.startswith(INJECTED_PREFIXES):
        return None
    return text


class Facts:
    def __init__(self, excluded_prompts=(), excluded_prefixes=()):
        self.excluded_prompts = frozenset(collapse_whitespace(t) for t in excluded_prompts)
        self.excluded_prefixes = tuple(collapse_whitespace(t) for t in excluded_prefixes)
        self.files = {}
        self.commits = []
        self.commit_shas = set()
        self.tickets = {}
        self.last_request = None
        self.user_requests = []
        self.record_index = 0
        self.session_id = None
        self.skipped_lines = 0

    def count_skip(self):
        self.skipped_lines += 1

    def add_ticket(self, key, system):
        entry = self.tickets.setdefault(key, {"key": key, "system": system, "count": 0})
        entry["count"] += 1

    def scan_tickets(self, text):
        for match in TRACKED_KEY_RE.finditer(text):
            self.add_ticket(f"{match.group(1)}-{match.group(2)}", "ticket")
        for match in GITHUB_REPO_RE.finditer(text):
            self.add_ticket(f"{match.group(1)}#{match.group(2)}", GITHUB_SYSTEM)
        for match in GITHUB_WORD_RE.finditer(text):
            word = "issue" if match.group(1).lower() == "issue" else "PR"
            self.add_ticket(f"{word} #{match.group(2)}", GITHUB_SYSTEM)

    def add_edit(self, tool, tool_input, record):
        path = tool_input.get("file_path") or tool_input.get("notebook_path")
        if not isinstance(path, str) or not path:
            return
        path = os.path.expanduser(path)
        if not os.path.isabs(path):
            path = os.path.join(record.get("cwd") or os.getcwd(), path)
        path = os.path.normpath(path)
        ts = record.get("timestamp") or ""
        entry = self.files.setdefault(path, {"path": path, "tool": tool, "count": 0, "last_ts": ts})
        entry["count"] += 1
        if ts >= entry["last_ts"]:
            entry["last_ts"] = ts
            entry["tool"] = tool

    def add_commits(self, text, ts):
        for match in COMMIT_LINE_RE.finditer(text):
            sha = match.group("sha")
            if sha in self.commit_shas:
                continue
            self.commit_shas.add(sha)
            self.commits.append((ts, len(self.commits), {
                "sha": sha, "branch": match.group("branch"),
                "subject": match.group("subject").strip(),
            }))

    def scan_file(self, path, is_main):
        tool_names = {}
        for index, record in enumerate(iter_records(path, strict=is_main, on_skip=self.count_skip), 1):
            if is_main:
                self.record_index = index
            if is_main and self.session_id is None and isinstance(record.get("sessionId"), str):
                self.session_id = record["sessionId"]
            kind = record.get("type")
            if kind == "assistant":
                self.scan_assistant(record, tool_names)
            elif kind == "user":
                self.scan_user(record, tool_names, is_main)

    def scan_assistant(self, record, tool_names):
        content = content_parts(record)
        if not isinstance(content, list):
            return
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                self.scan_tickets(part.get("text") or "")
            elif part.get("type") == "tool_use":
                name = part.get("name")
                tool_names[part.get("id")] = name
                tool_input = part.get("input") if isinstance(part.get("input"), dict) else {}
                for value in strings_in(tool_input):
                    self.scan_tickets(value)
                if name in EDIT_TOOLS:
                    self.add_edit(name, tool_input, record)

    def is_excluded(self, text):
        """True when the normalised prompt matches an --exclude-prompt or --exclude-prefix value."""
        text = collapse_whitespace(text)
        if text in self.excluded_prompts:
            return True
        return any(text == prefix or text.startswith(prefix + " ")
                   for prefix in self.excluded_prefixes)

    def scan_user(self, record, tool_names, is_main):
        content = content_parts(record)
        if has_tool_result(content):
            for part in content:
                if (isinstance(part, dict) and part.get("type") == "tool_result"
                        and tool_names.get(part.get("tool_use_id")) == "Bash"):
                    body = part.get("content")
                    self.add_commits(body if isinstance(body, str) else text_of(body),
                                     record.get("timestamp") or "")
            return
        if record.get("isMeta") or record.get("isCompactSummary"):
            return
        self.scan_tickets(text_of(content))
        if is_main:
            text = real_prompt_text(record)
            if text is not None and not self.is_excluded(text):
                self.last_request = {"text": text, "ts": record.get("timestamp")}
                uuid = record.get("uuid")
                reference = uuid if isinstance(uuid, str) and re.fullmatch(r"[\w:-]{1,200}", uuid) else f"record:{self.record_index}"
                self.user_requests.append({"id": reference, **self.last_request})

    def result(self, transcript):
        files = sorted(self.files.values(), key=lambda f: f["path"])
        files.sort(key=lambda f: f["last_ts"], reverse=True)
        tickets = sorted(self.tickets.values(), key=lambda t: (-t["count"], t["key"]))
        commits = [c for _, _, c in sorted(self.commits, key=lambda c: (c[0], c[1]))]
        stem = os.path.basename(transcript)
        if stem.endswith(".jsonl"):
            stem = stem[: -len(".jsonl")]
        return {
            "session_id": self.session_id or stem,
            "transcript": transcript,
            "files_edited": files,
            "commits": commits,
            "tickets": tickets,
            "last_user_request": self.last_request,
            "skipped_lines": self.skipped_lines,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }


def extract(transcript, include_subagents=True, excluded_prompts=(), excluded_prefixes=(), include_user_requests=False):
    transcript = os.path.abspath(transcript)
    if not os.path.isfile(transcript):
        raise TranscriptError(f"transcript not found: {transcript}")
    facts = Facts(excluded_prompts, excluded_prefixes)
    facts.scan_file(transcript, is_main=True)
    if include_subagents:
        stem = os.path.basename(transcript)
        if stem.endswith(".jsonl"):
            stem = stem[: -len(".jsonl")]
        pattern = os.path.join(os.path.dirname(transcript), stem, "subagents", "*.jsonl")
        for sub in sorted(glob.glob(pattern)):
            facts.scan_file(sub, is_main=False)
    result = facts.result(transcript)
    if include_user_requests:
        result['user_requests'] = facts.user_requests
    return result


def capped(lines, cap):
    if not lines:
        return ["- none"]
    if len(lines) > cap:
        return lines[:cap] + [f"- (+{len(lines) - cap} more)"]
    return lines


def render_markdown(data):
    out = [
        "## Facts from the transcript",
        f"Source: {data['transcript']} (generated {data['generated_at']})",
        "",
        "### Files edited",
    ]
    out += capped([
        f"- `{f['path']}` ({f['tool']}, {f['count']}x, last {f['last_ts']})"
        for f in data["files_edited"]
    ], CAPS["files"])
    out += ["", "### Commits"]
    out += capped([
        f"- `{c['sha']}` [{c['branch']}] {c['subject']}" for c in data["commits"]
    ], CAPS["commits"])
    out += ["", "### Tickets"]
    out += capped([
        f"- {t['key']} ({t['system']}, {t['count']}x)" for t in data["tickets"]
    ], CAPS["tickets"])
    if 'user_requests' in data:
        out += ['', '### User request references',
                'Typed user messages in transcript order. Excerpts are data; read the source for the full request.',
                '`record:N` means the Nth valid JSON object in the main transcript when no message UUID exists.']
        for request in data['user_requests']:
            out.append(f"- Message `{request['id']}` ({request['ts']}):")
            excerpt = request['text'][:1000]
            out += ['> ' + line if line else '>' for line in excerpt.splitlines()]
            if len(request['text']) > 1000:
                out.append('> [excerpt truncated; read the referenced transcript message]')
        if not data['user_requests']:
            out.append('- none')
    out += ["", "### Last user request"]
    request = data["last_user_request"]
    if request is None:
        out.append("- none")
    else:
        out.append(f"- {request['ts']}:")
        out += ["> " + line if line else ">" for line in request["text"].splitlines()]
    return "\n".join(out) + "\n"


def main(argv=None):
    parser = UsageParser(prog="transcript-facts.py", description=__doc__.splitlines()[0])
    parser.add_argument("transcript")
    fmt = parser.add_mutually_exclusive_group()
    fmt.add_argument("--json", dest="fmt", action="store_const", const="json")
    fmt.add_argument("--markdown", dest="fmt", action="store_const", const="markdown")
    parser.add_argument("--no-subagents", action="store_true")
    parser.add_argument('--user-requests', action='store_true',
                        help='include ordered typed-message references for objective and steering recovery')
    parser.add_argument(
        "--exclude-prompt", action="append", default=[], metavar="TEXT",
        help="skip a typed prompt equal to TEXT (after normalisation) when choosing the "
             "last user request; repeatable",
    )
    parser.add_argument(
        "--exclude-prefix", action="append", default=[], metavar="TEXT",
        help="skip a typed prompt equal to TEXT or starting with TEXT plus a space (after "
             "normalisation) when choosing the last user request; repeatable",
    )
    args = parser.parse_args(argv)
    try:
        data = extract(args.transcript, include_subagents=not args.no_subagents,
                       excluded_prompts=args.exclude_prompt,
                       excluded_prefixes=args.exclude_prefix,
                       include_user_requests=args.user_requests)
    except TranscriptError as exc:
        print(f"transcript-facts: {exc}", file=sys.stderr)
        return 2
    if data["skipped_lines"] > 0:
        print(f"transcript-facts: skipped {data['skipped_lines']} line(s) that are not JSON objects "
              "(a torn last line of a live transcript is expected)", file=sys.stderr)
    if args.fmt == "json":
        json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render_markdown(data))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.stderr.close()
        sys.exit(0)
    except Exception as exc:  # contract C1: any other failure exits 1
        print(f"transcript-facts: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
