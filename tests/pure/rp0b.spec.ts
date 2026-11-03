import { fixturePath } from '../fixtures/paths'

// Redesign P0.4: the band's Cancel ("Handoff queued for this turn end") drops a pending manual handoff.
import { expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'
import type { MachineEvent } from '../../hooks/machine'

const CONFIG = resolveConfig({}, {}).config
const SID = '11111111-aaaa-4bbb-8ccc-000000000001'

test('Cancel while a manual handoff waits for the turn end drops it; the turn end then does nothing', () => {
  let s = { ...initialState(SID, 0, 'o'), transcriptPath: fixturePath('t.jsonl') }
  s = step(s, { type: 'manualBrief', now: 1, path: fixturePath('b.md'), turnId: 't1', markers: null } as MachineEvent, CONFIG).state
  const cancelled = step(s, { type: 'cancel', now: 2, reason: 'button' }, CONFIG)
  expect(cancelled.state.manualPending).toBeNull()
  expect(cancelled.effects.some(f => f.type === 'log' && f.event === 'manual-cancelled')).toBe(true)
  const end = step(cancelled.state, { type: 'turnEnd', now: 3, sessionId: SID, turnId: 't1', reason: 'answer', percent: 10, tokens: 1, draft: '', isKillSwitchOn: false, openReviews: 0, answer: '' }, CONFIG)
  expect(end.state.phase).toBe('IDLE')
  expect([cancelled.state.failedCycles, cancelled.state.backoffTokens]).toEqual([0, null])
})
