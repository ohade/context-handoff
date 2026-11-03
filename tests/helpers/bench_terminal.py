"""Measure the release's 500-input latency gate in a disposable cmux session.

This sends unsent draft edits, never Enter. The receipt measures terminal-buffer
acknowledgment and native hook timings, not physical display paint latency.
Observed gate: Reliable auto-handoff and caller-agnostic Track, 2026-10-07.
"""

import argparse
import datetime
import json
import math
import re
import subprocess
import time
from pathlib import Path


def cmux(*args: str) -> str:
    result = subprocess.run(["cmux", *args], capture_output=True, text=True, check=True, timeout=5)
    return result.stdout


def draft(workspace: str) -> str:
    screen = cmux("read-screen", "--workspace", workspace, "--lines", "10")
    rows = [line.strip() for line in screen.splitlines() if line.strip().startswith("❯")]
    if len(rows) != 1:
        raise RuntimeError("expected one visible composer row in the disposable workspace")
    return rows[0][1:].strip()


def wait_for(workspace: str, expected: str) -> None:
    deadline = time.perf_counter() + 3
    while draft(workspace) != expected:
        if time.perf_counter() >= deadline:
            raise RuntimeError("draft did not acknowledge the expected edit within 3 seconds")


def p95(values: list[float]) -> float | None:
    return sorted(values)[math.ceil(len(values) * 0.95) - 1] if values else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--debug-log", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--events", type=int, default=500)
    args = parser.parse_args()
    if args.events < 500 or args.events % 2:
        parser.error("events must be even and at least 500")
    initial = draft(args.workspace)
    if initial and not initial.startswith('Try "'):
        raise RuntimeError("refusing to replace a nonempty draft")
    marker = "latency-probe"
    cmux("send", "--workspace", args.workspace, marker)
    wait_for(args.workspace, marker)
    log_offset = args.debug_log.stat().st_size
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    timings = []
    for index in range(args.events):
        began = time.perf_counter()
        if index % 2 == 0:
            cmux("send", "--workspace", args.workspace, "x")
            expected = marker + "x"
        else:
            cmux("send-key", "--workspace", args.workspace, "backspace")
            expected = marker
        wait_for(args.workspace, expected)
        timings.append((time.perf_counter() - began) * 1000)
    # Use the independently checked backspace path; modified key names can be
    # accepted by cmux without producing the expected control byte in the TUI.
    for _ in marker:
        cmux("send-key", "--workspace", args.workspace, "backspace")
    with args.debug_log.open("rb") as stream:
        stream.seek(log_offset)
        lines = stream.read().decode("utf-8").splitlines()
    hooks: dict[str, list[float]] = {}
    receipts = []
    for line in lines:
        match = re.search(r"hooks module .*? (prompt.edit|ui.render|tool.call|turn.complete) settled in ([\d.]+)ms", line)
        if match:
            hooks.setdefault(match[1], []).append(float(match[2]))
            receipts.append(line)
    result = {
        "evidence": "LIVE", "subject": args.debug_log.stem, "workspace": args.workspace,
        "started": started, "ended": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "metric": "cmux input to terminal-buffer acknowledgment; physical paint unmeasured",
        "events": args.events, "acknowledged": len(timings), "input_ms": timings,
        "input_p95_ms": p95(timings),
        "hooks": {name: {"count": len(values), "p95_ms": p95(values)} for name, values in hooks.items()},
        "native_receipts": receipts,
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key not in {"input_ms", "native_receipts"}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
