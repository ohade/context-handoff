import { fixturePath } from '../fixtures/paths'

import { expect, test } from 'bun:test'

import { resolveConfig, TIMEOUTS_MS } from '../../hooks/config'
import { guardTurnEnd } from '../../hooks/guards'
import { initialState, step } from '../../hooks/machine'
import { stopRecord } from '../../hooks/turns'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const CONFIG = resolveConfig({}, {}).config

test('missing Stop activity is unknown, never authoritative idle', () => {
  expect(stopRecord({ transcript_path: fixturePath('t.jsonl') })).toMatchObject({ backgroundTasks: null, sessionCrons: null })
})

test('unknown activity prevents a turn-end handoff even when a transcript is known', () => {
  const observed = stopRecord({ transcript_path: fixturePath('t.jsonl') })!
  const state = step(initialState(SID, 0, 'owner'), observed, CONFIG).state
  expect(guardTurnEnd(state, { type: 'turnEnd', now: 1, sessionId: SID, tokens: 750_000, percent: 75, reason: 'answer', answer: 'done', draft: '', isKillSwitchOn: false, openReviews: 0 }, CONFIG)).toBe('activity-unknown')
})

test('successful clear starts the bounded new-ID poll without a classic event', () => {
  const state = { ...initialState(SID, 0, 'owner'), phase: 'CLEARING' as const, cycleId: `${SID}#1`, clearingFrom: SID, deadline: 30_000 }
  const result = step(state, { type: 'clearResult', now: 1, cycleId: `${SID}#1` }, CONFIG)

  expect(result.effects).toContainEqual({ type: 'pollNewId', cycleId: `${SID}#1`, oldSessionId: SID, withinMs: TIMEOUTS_MS.newIdPoll })
})
