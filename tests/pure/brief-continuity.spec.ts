// FIXTURE: a status question cannot replace unfinished work; Track is not authority.
import { expect, test } from 'bun:test'
import { instructionsFor } from '../../hooks/brief'

test('continuation follows the unfinished user objective with later steering and source references', () => {
  const text = instructionsFor('continue', 'session-id').join('\n')
  expect(text).toContain('unfinished user objective')
  expect(text).toContain('User request references')
  expect(text).toContain('later steering')
  expect(text).not.toContain('finish only the request shown under "Last user request"')
  expect(text).toContain('Track rows do not choose the objective')
})

test('a refused full restoration never permits steps-only continuation', () => {
  const text = instructionsFor('continue', 'session-id').join('\n')
  expect(text).toContain('expected_checkpoint')
  expect(text).toContain('applied_checksum')
  expect(text).not.toContain('mcp__track__restore_steps')
  expect(text).not.toContain('A refusal or a missing tool is fine: continue')
})
