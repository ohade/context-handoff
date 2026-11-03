"""FIXTURE: portable ticket extraction uses only synthetic transcripts."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid


SCRIPT = Path(__file__).resolve().parents[1] / "transcript-facts.py"


class TranscriptFactsTest(unittest.TestCase):
    def extract(self, text):
        with tempfile.TemporaryDirectory(prefix="context-handoff-extractor-") as directory:
            path = Path(directory) / f"{uuid.uuid4()}.jsonl"
            record = {"type": "user", "uuid": str(uuid.uuid4()),
                      "message": {"role": "user", "content": text}}
            path.write_text(json.dumps(record) + "\n", encoding="utf-8")
            result = subprocess.run(
                ["python3", str(SCRIPT), str(path), "--json", "--no-subagents"],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_project_keys_are_generic_and_do_not_guess_the_tracking_system(self):
        data = self.extract("Continue TASK-42 and OPS2-7, then revisit TASK-42.")
        tickets = {ticket["key"]: ticket for ticket in data["tickets"]}
        self.assertEqual(set(tickets), {"TASK-42", "OPS2-7"})
        self.assertEqual(tickets["TASK-42"]["count"], 2)
        self.assertEqual({ticket["system"] for ticket in tickets.values()}, {"ticket"})

    def test_project_key_boundaries_do_not_extract_substrings(self):
        data = self.extract("Ignore lower-4, prefix-TASK-9-extra, TASK_12 and TASK-2suffix.")
        self.assertEqual(data["tickets"], [])

    def test_github_references_keep_their_explicit_source(self):
        data = self.extract("Continue sample-owner/sample-project#14 and issue #8.")
        self.assertEqual({ticket["key"] for ticket in data["tickets"]},
                         {"sample-owner/sample-project#14", "issue #8"})
        self.assertEqual({ticket["system"] for ticket in data["tickets"]}, {"github"})


if __name__ == "__main__":
    unittest.main()
