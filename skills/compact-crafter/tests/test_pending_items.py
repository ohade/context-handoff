"""CC-181 FIXTURE: declared pending items have individual, checked Track refs."""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from fixture_snapshot import snapshot_text

SKILL = Path(__file__).resolve().parent.parent
BASE = snapshot_text()
ITEM = {"track_id": "plan:76", "subject": "Retention decision", "note": "Owner: User; needs a decision", "unblock": "yes, save that memory"}


def check(tmp_path, lines):
    snapshot = tmp_path / "snapshot.md"
    snapshot.write_text(BASE.replace("## 3. Pending, owned by the user\n- none", "## 3. Pending, owned by the user\n" + "\n".join(lines)), encoding="utf-8")
    return subprocess.run([sys.executable, str(SKILL / "scripts/check-snapshot.py"), str(snapshot)], capture_output=True, text=True, check=False)


def test_each_pending_item_is_a_record_not_three_bullets_for_four_decisions(tmp_path):
    result = check(tmp_path, ["- Retention decision", "- Tracker decision", "- Release decision and Performance decision"])
    assert result.returncode == 1
    assert "pending" in result.stderr


@pytest.mark.parametrize("item", [
    {**ITEM, "track_id": "S76"}, {**ITEM, "unblock": ""}, {**ITEM, "note": ""},
    {**ITEM, "subject": ""}, {**ITEM, "extra": "untracked second decision"},
])
def test_malformed_pending_record_is_rejected(tmp_path, item):
    result = check(tmp_path, ["- Pending: " + json.dumps(item)])
    assert result.returncode == 1
    assert "pending" in result.stderr


def test_duplicate_track_reference_is_rejected(tmp_path):
    result = check(tmp_path, ["- Pending: " + json.dumps(ITEM)] * 2)
    assert result.returncode == 1
    assert "duplicate" in result.stderr


def test_four_distinct_records_and_explicit_absent_track_notes_are_valid(tmp_path):
    items = [{**ITEM, "track_id": f"plan:{76+i}", "subject": subject} for i, subject in enumerate(["Retention", "Tracker", "Release", "Performance"])]
    assert check(tmp_path, ["- Pending: " + json.dumps(item) for item in items]).returncode == 0
    assert check(tmp_path, ["- Pending: " + json.dumps({**ITEM, "track_id": None})]).returncode == 0
