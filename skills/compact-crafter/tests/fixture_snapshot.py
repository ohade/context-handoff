"""Materialize the synthetic snapshot with generated paths."""

from pathlib import Path
import tempfile


_TEMPORARY = tempfile.TemporaryDirectory(prefix="context-handoff-snapshot-")
_ROOT = Path(_TEMPORARY.name)
_TEMPLATE = Path(__file__).parent / "fixtures" / "valid-snapshot.md"


def snapshot_text():
    return (_TEMPLATE.read_text(encoding="utf-8")
            .replace("@TRANSCRIPT@", str(_ROOT / "synthetic.jsonl"))
            .replace("@WORKTREE@", str(_ROOT / "sample-project")))


def snapshot_fixture():
    path = _ROOT / "snapshot.md"
    path.write_text(snapshot_text(), encoding="utf-8")
    return path
