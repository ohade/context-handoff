"""FIXTURE checks for the plugin-owned command-hook activity relay."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).parents[2] / 'hooks' / 'lifecycle-relay.py'
SID = '11111111-aaaa-4bbb-8ccc-000000000001'


class LifecycleRelayTest(unittest.TestCase):
    def relay(self, directory, **fields):
        payload = {'hook_event_name': 'Stop', 'session_id': SID,
                   'transcript_path': str(Path(directory) / 'session.jsonl'), **fields}
        env = {**os.environ, 'CONTEXT_HANDOFF_STATE_DIR': directory,
               'CONTEXT_HANDOFF_OWNER': 'owner',
               'CONTEXT_HANDOFF_ACTIVITY_GENERATION': 'generation'}
        result = subprocess.run(['python3', str(SCRIPT)], input=json.dumps(payload),
                                text=True, capture_output=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(directory) / 'relay' / f'{SID}.json'

    def test_missing_activity_stays_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            data = json.loads(self.relay(directory).read_text())
            self.assertIsNone(data['background_tasks'])
            self.assertIsNone(data['session_crons'])
            self.assertEqual(data['owner'], 'owner')
            self.assertEqual(data['generation'], 'generation')

    def test_known_empty_activity_and_identity_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.relay(directory, background_tasks=[], session_crons=[])
            data = json.loads(path.read_text())
            self.assertEqual(data['background_tasks'], [])
            self.assertEqual(data['session_crons'], [])
            self.assertEqual(data['session_id'], SID)
            self.assertEqual(data['transcript_path'], str(Path(directory) / 'session.jsonl'))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_subagent_cannot_replace_the_main_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.relay(directory, background_tasks=[], session_crons=[])
            before = path.read_bytes()
            self.relay(directory, agent_id='worker', background_tasks=[{'id': 'busy'}])
            self.assertEqual(path.read_bytes(), before)

    def test_invalid_session_id_cannot_escape_the_relay_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            self.relay(directory, session_id='../escape')
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
