"""FIXTURE: manual lookup must honor an isolated Claude configuration.

Observed 2026-11-02: native manual handoffs searched the default project folder,
then searched the whole home directory despite CLAUDE_CONFIG_DIR being set.
"""

import os
import re
import subprocess
import uuid
from pathlib import Path


SKILL = Path(__file__).resolve().parents[1] / "SKILL.md"


def test_documented_manual_lookup_finds_isolated_transcript(tmp_path):
    session = str(uuid.uuid4())
    profile = tmp_path / "isolated profile"
    transcript = profile / "projects" / "sample-project" / f"{session}.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n", encoding="utf-8")
    header = SKILL.read_text(encoding="utf-8").split("**Header values.**", 1)[1]
    match = re.search(r"^- `transcript`: `([^`]+)`\.", header, re.MULTILINE)
    assert match is not None, "manual transcript lookup command is missing"
    command = match.group(1).replace("<session>", session)
    result = subprocess.run(
        ["sh", "-c", command],
        cwd=tmp_path,
        env={**os.environ, "CLAUDE_CONFIG_DIR": str(profile)},
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(transcript), (
        "manual lookup did not select the configured profile transcript"
    )
