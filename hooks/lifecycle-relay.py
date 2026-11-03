#!/usr/bin/env python3
"""Relay ordinary lifecycle inputs without replacing managed hook decisions.

Observed defect, 2026-10-07: managed function-hook short circuiting left
context-handoff without a transcript or authoritative activity observation.
Only SessionStart/Stop launch this helper; tool updates launch no process.
"""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

SESSION_ID = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')
MAX_INPUT_BYTES = 1024 * 1024


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError('oversized lifecycle input')
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError('invalid lifecycle input')
    session = data.get('session_id')
    event = data.get('hook_event_name')
    if (data.get('agent_id') is not None or not isinstance(session, str)
            or not SESSION_ID.fullmatch(session)
            or event not in ('SessionStart', 'Stop')):
        return
    snapshot = {
        'v': 1, 'event': event, 'session_id': session,
        'owner': os.environ.get('CONTEXT_HANDOFF_OWNER'),
        'generation': os.environ.get('CONTEXT_HANDOFF_ACTIVITY_GENERATION'),
        'observed_at': time.time_ns() / 1_000_000,
        'transcript_path': data.get('transcript_path'),
        'background_tasks': data.get('background_tasks') if isinstance(data.get('background_tasks'), list) else None,
        'session_crons': data.get('session_crons') if isinstance(data.get('session_crons'), list) else None,
    }
    root = Path(os.environ.get('CONTEXT_HANDOFF_STATE_DIR') or Path.home() / '.claude/state/context-handoff') / 'relay'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=root, delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            json.dump(snapshot, stream, ensure_ascii=False, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / f'{session}.json')
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError) as error:
        # No payload or private path in a hook diagnostic. A missing snapshot
        # remains unknown; this relay never grants permission or allows clear.
        print(f'context-handoff relay unavailable: {type(error).__name__}', file=sys.stderr)
    print('{}')
