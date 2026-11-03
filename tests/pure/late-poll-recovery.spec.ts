import { fixturePath } from '../fixtures/paths'

import { expect, test } from 'bun:test'
import { resolveConfig } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const NEW = '22222222-aaaa-4bbb-8ccc-000000000002'
const CONFIG = resolveConfig({}, {}).config

test('an uncertain clear retains its brief for bounded late-ID recovery without submitting in the old session', () => {
  const state = { ...initialState(SID, 0, 'owner'), phase: 'CLEARING' as const, cycleId: `${SID}#1`, clearingFrom: SID, briefPath: fixturePath('brief.md'), deadline: 30_000 }
  const missing = step(state, { type: 'newIdResolved', now: 5_000, cycleId: `${SID}#1`, sessionId: null }, CONFIG)
  expect(missing.state.phase).toBe('IDLE')
  expect(missing.effects.some(e => e.type === 'submitSeed' || e.type === 'fillSeed')).toBe(false)
  const landed = step(missing.state, { type: 'sessionStart', now: 6_000, sessionId: NEW, source: 'clear' }, CONFIG)
  expect(landed.effects).toContainEqual({ type: 'fillSeed', briefPath: fixturePath('brief.md') })
  expect(landed.effects.some(e => e.type === 'submitSeed')).toBe(false)
})
