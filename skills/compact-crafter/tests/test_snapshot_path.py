"""Tests for scripts/snapshot-path.py: the snapshot file name and the created value."""

import datetime
import re
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "snapshot-path.py"
FULL_ID = "11111111-aaaa-4bbb-8ccc-000000000001"
CREATED_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$")


def run(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def parse(stdout):
    fields = dict(line.split("=", 1) for line in stdout.splitlines())
    assert sorted(fields) == ["created", "path"], stdout
    return fields


def minute_stamps():
    """This minute and the next, so a test that pre-creates files survives a minute boundary."""
    now = datetime.datetime.now()
    return [(now + datetime.timedelta(minutes=step)).strftime("%Y%m%d-%H%M") for step in (0, 1)]


def test_first_free_number_is_1(tmp_path):
    result = run("--session", FULL_ID, "--dir", str(tmp_path))
    assert result.returncode == 0, result.stderr
    path = Path(parse(result.stdout)["path"])
    assert path.parent == tmp_path
    assert re.fullmatch(rf"{FULL_ID}-\d{{8}}-\d{{4}}-1\.md", path.name), path.name
    assert not path.exists(), "the script must not write the snapshot"


def test_number_is_2_when_1_exists(tmp_path):
    for stamp in minute_stamps():
        (tmp_path / f"{FULL_ID}-{stamp}-1.md").write_text("taken\n", encoding="utf-8")
    result = run("--session", FULL_ID, "--dir", str(tmp_path))
    assert result.returncode == 0, result.stderr
    assert parse(result.stdout)["path"].endswith("-2.md")


def test_missing_dir_is_created(tmp_path):
    target = tmp_path / "nested" / "compact-handoffs"
    result = run("--session", FULL_ID, "--dir", str(target))
    assert result.returncode == 0, result.stderr
    assert target.is_dir()
    assert list(target.iterdir()) == []


def test_created_is_local_iso_8601_with_offset(tmp_path):
    result = run("--session", FULL_ID, "--dir", str(tmp_path))
    assert result.returncode == 0, result.stderr
    created = parse(result.stdout)["created"]
    assert CREATED_RE.match(created), created
    parsed = datetime.datetime.fromisoformat(created)
    assert abs(datetime.datetime.now().astimezone() - parsed) < datetime.timedelta(minutes=2)


def test_short_id_is_rejected(tmp_path):
    result = run("--session", "11111111", "--dir", str(tmp_path))
    assert result.returncode == 2
    assert "short id" in result.stderr
    assert result.stdout == ""


@pytest.mark.parametrize("session", ["../x", "a/b-c-d-e-f-g-h", "", ".hidden-session-id", "id with space"])
def test_unsafe_id_is_rejected(tmp_path, session):
    result = run("--session", session, "--dir", str(tmp_path))
    assert result.returncode == 2
    assert "unsafe session id" in result.stderr
    assert result.stdout == ""
    assert list(tmp_path.iterdir()) == []


def test_missing_dir_is_created_private(tmp_path):
    # Review finding cc M11 (2026-10-20): the folder holds full prompts but was created 0755.
    target = tmp_path / "nested" / "handoffs"
    result = run("--session", FULL_ID, "--dir", str(target))
    assert result.returncode == 0, result.stderr
    assert target.stat().st_mode & 0o777 == 0o700
    assert (tmp_path / "nested").stat().st_mode & 0o077 == 0
