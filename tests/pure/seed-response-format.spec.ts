// FIXTURE: the 2026-11-02 native continuation added a generic report to an exact response.
// Check the generated prompt contract; model compliance needs a fresh native run.
import { expect, test } from 'bun:test'
import { instructionsFor } from '../../hooks/brief'

test('wait mode honors a verified user response format only after required restoration', () => {
  const lines = instructionsFor('wait', 'source-session')
  const response = lines.find(line => line.startsWith('4.'))!
  expect(response).toContain('After required restoration and reconciliation succeed')
  expect(response).toContain('actual user messages')
  expect(response).toContain('exact wording without added commentary')
  expect(response).toContain('Otherwise report what is done and pending in at most five lines')
  expect(response).toContain('stop until the user replies')
  expect(lines[0]).toContain('A missing, refused or incompatible full restoration means stop and report')
})
