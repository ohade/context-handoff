"""FIXTURE checks for the documented snapshot command's directory selection."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "snapshot-path.py"
SESSION = "11111111-aaaa-4bbb-8ccc-000000000001"


def allocate(tmp_path, override, *args):
    home = tmp_path / "home"
    home.mkdir()
    env = {**os.environ, "HOME": str(home)}
    env.pop("CONTEXT_HANDOFF_BRIEF_DIR", None)
    if override is not None:
        env["CONTEXT_HANDOFF_BRIEF_DIR"] = str(override)
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--session", SESSION, *args],
        env=env, text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines())
    return Path(fields["path"]), home


def test_documented_command_honors_configured_brief_directory(tmp_path):
    configured = tmp_path / "configured briefs"
    allocated, home = allocate(tmp_path, configured)
    assert allocated.parent == configured
    assert configured.is_dir()
    assert not (home / ".claude").exists()
    assert not allocated.exists()


def test_explicit_directory_takes_precedence(tmp_path):
    configured = tmp_path / "configured"
    explicit = tmp_path / "explicit"
    allocated, home = allocate(tmp_path, configured, "--dir", str(explicit))
    assert allocated.parent == explicit
    assert not configured.exists()
    assert not (home / ".claude").exists()


@pytest.mark.parametrize("override", [None, ""])
def test_unset_or_empty_override_uses_home_default(tmp_path, override):
    allocated, home = allocate(tmp_path, override)
    assert allocated.parent == home / ".claude" / "state" / "compact-handoffs"
