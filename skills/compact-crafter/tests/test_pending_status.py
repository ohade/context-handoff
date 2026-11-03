"""TRACK-23: structural checking preserves explicit paused and waiting states."""
import json

import pytest

from test_pending_items import ITEM, check


@pytest.mark.parametrize("status", ["paused", "waiting"])
def test_explicit_pending_status_passes_unchanged_checker(tmp_path, status):
    item = {**ITEM, "status": status, "note": "Full blocker details. " * 20}
    result = check(tmp_path, ["- Pending: " + json.dumps(item)])
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("status", ["completed", "in_progress", None, 1])
def test_unsupported_pending_status_is_rejected(tmp_path, status):
    result = check(tmp_path, ["- Pending: " + json.dumps({**ITEM, "status": status})])
    # Review finding cc M12 (2026-10-20): any nonzero exit passed, including a crash (exit 2).
    assert result.returncode == 1, result.stdout + result.stderr
    assert "pending: status must be paused or waiting" in result.stdout + result.stderr
