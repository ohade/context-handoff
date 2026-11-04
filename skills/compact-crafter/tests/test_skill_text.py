"""Tests on SKILL.md text that the context-handoff mod's armed-window allowlist depends on."""

import re
from pathlib import Path

SKILL_MD = Path(__file__).resolve().parent.parent / "SKILL.md"

# Shell executables a model might be told to run. A code span starting with one is a command.
SHELL_WORDS = {
    "awk", "bash", "cat", "cp", "curl", "date", "echo", "find", "git", "grep", "head", "jq", "ls",
    "mkdir", "mv", "pbcopy", "pbpaste", "printf", "python", "python3", "rm", "sed", "sh", "tail",
    "touch", "wc",
}

# The three commands the mod admits during an automatic run.
ALLOWED = {
    "snapshot-path": re.compile(
        r'^python3 "\$\{CLAUDE_PLUGIN_ROOT\}/skills/compact-crafter/scripts/snapshot-path\.py" --session \S+(?: --dir \S+)?$'
    ),
    "check-snapshot": re.compile(r'^python3 "\$\{CLAUDE_PLUGIN_ROOT\}/skills/compact-crafter/scripts/check-snapshot\.py" \S+$'),
    "transcript-find": re.compile(
        r'^find ~/\.claude/projects -maxdepth \d+ -name "\S+\.jsonl"(?: \| head -\d+)?$'
    ),
}


def automatic_run_paragraph():
    lines = SKILL_MD.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("**Automatic run.**"))
    end = next((i for i in range(start, len(lines)) if not lines[i].strip()), len(lines))
    return " ".join(lines[start:end])


def named_commands(text):
    spans = [span.strip() for span in re.findall(r"`([^`]+)`", text)]
    return [span for span in spans if span.split()[0] in SHELL_WORDS]


def test_automatic_run_names_only_allowed_commands():
    commands = named_commands(automatic_run_paragraph())
    not_allowed = [c for c in commands if not any(rx.match(c) for rx in ALLOWED.values())]
    assert not_allowed == [], f"commands outside the mod's allowlist: {not_allowed}"


def test_automatic_run_names_each_allowed_command():
    commands = named_commands(automatic_run_paragraph())
    missing = [name for name, rx in ALLOWED.items() if not any(rx.match(c) for c in commands)]
    assert missing == [], f"allowed commands not named in the Automatic-run paragraph: {missing}"


def test_skill_has_no_bang_shell_blocks():
    """A `!` + backtick block runs at skill expansion, outside the mod's allowlist."""
    hits = [
        f"{number}: {line}"
        for number, line in enumerate(SKILL_MD.read_text(encoding="utf-8").splitlines(), 1)
        if re.search(r"!`", line) or line.lstrip().startswith("```!")
    ]
    assert hits == [], hits


def fallback_paragraphs():
    text = SKILL_MD.read_text(encoding="utf-8")
    start = text.index("**Fallback: paste-ready `/compact` line.**")
    return text[start:text.index("## Checks", start)]


def test_clipboard_step_never_puts_the_line_in_a_shell_string():
    # Review finding cc M17 (2026-10-20): `printf '%s' "$LINE"` runs backticks and $(...) in the line.
    fallback = fallback_paragraphs()
    assert '"$LINE"' not in fallback
    assert "Write tool" in fallback and "pbcopy <" in fallback


def test_instruction_override_refusal_stops_instead_of_falling_back():
    # Review finding cc M2 (2026-10-20): after an injection refusal the fallback pointed the next
    # context at a snapshot that no injection check had passed.
    text = SKILL_MD.read_text(encoding="utf-8")
    invalid = text[text.index("- If it returns `snapshot invalid: <reason>`"):text.index("**Fallback: paste-ready")]
    assert "instruction" in invalid and "stop" in invalid.lower()
    assert "never offer the fallback" in fallback_paragraphs()


def test_open_rows_exact_copy_is_limited_to_track_backed_records():
    # plan:111 R2: skill-text contract only; it does not prove live model behaviour. The exact-copy
    # rule for the open-rows record applies to records with a track_id; a decision with no known
    # Track row keeps track_id null and its own conversation wording.
    text = automatic_run_paragraph()
    assert "open-rows.json" in text
    assert "For each record with a `track_id`" in text
    assert "keeps `track_id: null` and its own subject, note and unblock" in text
