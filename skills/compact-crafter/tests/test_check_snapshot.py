"""Tests for scripts/check-snapshot.py (contract C2)."""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest
from fixture_snapshot import snapshot_fixture

SKILL = Path(__file__).resolve().parent.parent
SCRIPT = SKILL / "scripts" / "check-snapshot.py"
TEMPLATE = SKILL / "reference" / "snapshot-template.md"
VALID = snapshot_fixture()


def run(snapshot, *extra):
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(snapshot), *extra],
        capture_output=True,
        text=True,
        check=False,
    )


def write_variant(tmp_path, transform):
    text = VALID.read_text(encoding="utf-8")
    changed = transform(text)
    assert changed != text, "the variant must differ from the valid fixture"
    path = tmp_path / "snapshot.md"
    path.write_text(changed, encoding="utf-8")
    return path


def assert_invalid(result, fragment):
    assert result.returncode == 1, result.stderr
    assert fragment in result.stderr, result.stderr


def test_valid_fixture_passes():
    result = run(VALID)
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""


def test_valid_fixture_passes_with_explicit_template():
    assert run(VALID, "--template", str(TEMPLATE)).returncode == 0


def test_missing_heading_fails(tmp_path):
    path = write_variant(tmp_path, lambda t: t.replace("## 9. Dead ends\n", ""))
    assert_invalid(run(path), "heading missing or not verbatim: ## 9. Dead ends")


def test_reworded_heading_fails(tmp_path):
    path = write_variant(tmp_path, lambda t: t.replace("## 7. Do not redo", "## 7. Do not repeat"))
    assert_invalid(run(path), "heading missing or not verbatim: ## 7. Do not redo")


def test_wrong_order_fails(tmp_path):
    def swap(text):
        text = text.replace("## 9. Dead ends", "@@NINE@@")
        text = text.replace("## 10. Assumptions to verify", "## 9. Dead ends")
        return text.replace("@@NINE@@", "## 10. Assumptions to verify")

    assert_invalid(run(write_variant(tmp_path, swap)), "heading out of order")


def test_missing_status_line_fails(tmp_path):
    path = write_variant(tmp_path, lambda t: t.replace("Status: answered\n", ""))
    assert_invalid(run(path), "has no 'Status:")


def test_duplicate_status_line_fails(tmp_path):
    path = write_variant(tmp_path, lambda t: t.replace("Status: answered\n", "Status: answered\nStatus: partial\n"))
    assert_invalid(run(path), "2 Status lines")


def test_invalid_status_value_fails(tmp_path):
    path = write_variant(tmp_path, lambda t: t.replace("Status: answered", "Status: done"))
    assert_invalid(run(path), "invalid line 'Status: done'")


def test_status_outside_section_8_does_not_count(tmp_path):
    def move(text):
        text = text.replace("Status: answered\n", "")
        return text.replace("## 9. Dead ends\n", "## 9. Dead ends\nStatus: answered\n")

    assert_invalid(run(write_variant(tmp_path, move)), "has no 'Status:")


def test_short_session_id_fails(tmp_path):
    path = write_variant(
        tmp_path,
        lambda t: t.replace(f"session: {FULL_ID}", f"session: {FULL_ID[:8]}"),
    )
    assert_invalid(run(path), "8-character short id")


@pytest.mark.parametrize("key", ["session", "previous", "transcript", "created"])
def test_missing_header_key_fails(tmp_path, key):
    def drop(text):
        lines = text.splitlines(keepends=True)
        return "".join(line for line in lines if not line.startswith(f"{key}: "))

    assert_invalid(run(write_variant(tmp_path, drop)), f"missing '{key}:'")


def test_empty_header_value_fails(tmp_path):
    path = write_variant(tmp_path, lambda t: t.replace("previous: none", "previous: "))
    assert_invalid(run(path), "'previous:' has an empty value")


def test_placeholder_header_value_fails(tmp_path):
    path = write_variant(tmp_path, lambda t: t.replace("previous: none", "previous: <previous id or none>"))
    assert_invalid(run(path), "'previous:' still holds the template placeholder")


def test_header_beyond_line_15_fails(tmp_path):
    def push_down(text):
        return "\n" * 15 + text

    assert_invalid(run(write_variant(tmp_path, push_down)), "missing 'session:' in the first 15 lines")


def test_unreadable_snapshot_exits_2(tmp_path):
    result = run(tmp_path / "does-not-exist.md")
    assert result.returncode == 2
    assert "cannot read" in result.stderr


def test_unreadable_template_exits_2(tmp_path):
    result = run(VALID, "--template", str(tmp_path / "missing-template.md"))
    assert result.returncode == 2


def test_extra_template_heading_fails_valid_snapshot(tmp_path):
    template = tmp_path / "template.md"
    template.write_text(
        TEMPLATE.read_text(encoding="utf-8") + "\n## 11. Extra section\n*Guidance.*\n",
        encoding="utf-8",
    )
    assert run(VALID).returncode == 0
    assert_invalid(run(VALID, "--template", str(template)), "heading missing or not verbatim: ## 11. Extra section")


def test_template_defines_ten_headings_and_four_keys():
    spec = importlib.util.spec_from_file_location("check_snapshot", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    keys, headings, status_heading = module.parse_template(TEMPLATE)
    assert keys == ["session", "previous", "transcript", "created"]
    assert len(headings) == 10
    assert status_heading == "## 8. Last request and status"


FULL_ID = "11111111-aaaa-4bbb-8ccc-000000000001"


def copy_valid_as(tmp_path, name):
    path = tmp_path / name
    path.write_text(VALID.read_text(encoding="utf-8"), encoding="utf-8")
    return path


@pytest.mark.parametrize("suffix", ["", "-1", "-2", "-12"])
def test_snapshot_name_with_optional_cycle_suffix_passes(tmp_path, suffix):
    path = copy_valid_as(tmp_path, f"{FULL_ID}-20261005-1558{suffix}.md")
    result = run(path)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("suffix", ["", "-2"])
def test_short_id_in_snapshot_name_fails(tmp_path, suffix):
    path = copy_valid_as(tmp_path, f"11111111-20261005-1558{suffix}.md")
    assert_invalid(run(path), "file name: session '11111111' is an 8-character short id")


@pytest.mark.parametrize("suffix", ["", "-3"])
def test_stale_session_id_in_snapshot_name_fails(tmp_path, suffix):
    stale = "11111111-2222-4333-8444-555555555555"
    path = copy_valid_as(tmp_path, f"{stale}-20261005-1558{suffix}.md")
    assert_invalid(run(path), f"file name: session '{stale}' does not match header session '{FULL_ID}'")


DEFERRED_RECORD = (
    '- Pending: {"track_id":"plan:999","subject":"Ship it","note":"waits on User",'
    '"unblock":"ship it"}'
)


@pytest.mark.parametrize("block", [
    "## Deferred\n" + DEFERRED_RECORD + "\n",
    "## Deferred\n- User still has to decide the release date.\n",
])
def test_extra_level2_heading_cannot_hide_pending_records(tmp_path, block):
    # Review finding cc M1 (2026-10-20): section 3 ended at any '## ' line, so a record under
    # an invented heading passed this checker and skipped the mod's Track preflight.
    path = write_variant(tmp_path, lambda text: text.replace(
        "## 4. In flight", block + "\n## 4. In flight"))
    assert_invalid(run(path), "unexpected heading: ## Deferred")


def test_pending_record_outside_section_3_fails(tmp_path):
    path = write_variant(tmp_path, lambda text: text.replace(
        "## 5. Identifiers the next context must type",
        DEFERRED_RECORD + "\n\n## 5. Identifiers the next context must type"))
    assert_invalid(run(path), "pending: '- Pending:' record outside section 3")


def test_section_left_as_template_guidance_fails(tmp_path):
    # Review finding cc M10 (2026-10-20): a section holding only its italic guidance line passed.
    guidance = "*Quote them; never paraphrase a rule.*"
    path = write_variant(tmp_path, lambda text: text.replace(
        '- 2026-10-04: "never commit, push, stash, reset or checkout"', guidance))
    assert_invalid(run(path), "template guidance left unfilled")
