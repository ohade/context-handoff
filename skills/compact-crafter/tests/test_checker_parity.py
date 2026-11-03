"""Review findings cc M5, M7, M8, M13, M15 (2026-10-20): exit 0 here must mean the mod accepts.

Each refused variant below was refused by the context-handoff mod and passed this checker.
`mods/context-handoff/tests/pure/checker-parity.spec.ts` holds the mod's side of the same corpus.
"""
import json

import pytest

from test_check_snapshot import VALID, assert_invalid, run, write_variant
from test_pending_items import ITEM, check

SESSION = "11111111-aaaa-4bbb-8ccc-000000000001"


@pytest.mark.parametrize("name, transform, fragment", [
    ("v4b not a full UUID", lambda t: t.replace(f"session: {SESSION}", "session: synthetic-session-without-uuid-shape"),
     "header: session"),
    ("v5 key without a space", lambda t: t.replace(f"session: {SESSION}", f"session:{SESSION}"),
     "header: 'session:' must be written as 'session: <value>'"),
    ("v6 heading twice", lambda t: t.replace("## 4. In flight", "## 4. In flight\n- none\n\n## 4. In flight"),
     "heading appears 2 times: ## 4. In flight"),
])
def test_variants_the_mod_refuses_fail_here(tmp_path, name, transform, fragment):
    assert_invalid(run(write_variant(tmp_path, transform)), fragment)


def test_repeated_json_key_is_rejected(tmp_path):
    record = json.dumps(ITEM)[:-1] + ', "note": "a second, different note"}'
    result = check(tmp_path, ["- Pending: " + record])
    assert result.returncode == 1, result.stdout + result.stderr
    assert "repeated key" in result.stderr


def test_key_error_names_the_optional_status_key(tmp_path):
    result = check(tmp_path, ["- Pending: " + json.dumps({**ITEM, "status": "paused", "extra": "x"})])
    assert result.returncode == 1
    assert "optionally status" in result.stderr


def test_every_bad_record_is_reported(tmp_path):
    result = check(tmp_path, ["- Pending: " + json.dumps({**ITEM, "unblock": ""}),
                              "- Pending: " + json.dumps({**ITEM, "track_id": "plan:77", "status": "done"})])
    assert result.returncode == 1
    assert "nonempty strings" in result.stderr and "paused or waiting" in result.stderr


def test_line_separator_inside_a_note_is_kept_like_the_mod(tmp_path):
    result = check(tmp_path, ["- Pending: " + json.dumps({**ITEM, "note": "first second"}, ensure_ascii=False)])
    assert result.returncode == 0, result.stdout + result.stderr


def test_valid_fixture_still_passes():
    assert run(VALID).returncode == 0
