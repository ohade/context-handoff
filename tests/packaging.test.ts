// FIXTURE: the native test kit records command dispatch without starting a model turn.
import { expect, mock, test } from 'claude-code/testing'

import { SESSION_START, TRANSCRIPT, TURN, worldOf } from './fixtures/world'

test('automatic handoff selects the skill owned by this plugin', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await $.session.start(SESSION_START)
  await $.classic.Stop({
    stop_hook_active: false, background_tasks: [], session_crons: [],
    transcript_path: TRANSCRIPT, session_id: world.sessionId,
  })
  await $.prompt.submit({ text: 'Continue the synthetic sample task.', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'Continue the synthetic sample task.', turnId: TURN.turnId })
  await $.turn.complete(TURN)
  await clock.settle()
  await clock.advance(10)
  await clock.settle()

  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
})
