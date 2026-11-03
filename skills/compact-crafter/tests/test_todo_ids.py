"""FIXTURE: Track TodoWrite IDs preserve normalized multiword titles."""
import json

from test_pending_items import ITEM, check


def test_multiword_todo_reference_is_valid(tmp_path):
    result = check(tmp_path, ["- Pending: " + json.dumps({**ITEM, "track_id": "todo:review patch"})])
    assert result.returncode == 0, result.stderr
