import { fixturePath } from '../fixtures/paths'

// A Cancel press means "not now" (lifted only by growth).
// A fresh session after a handoff starts with clean counters and no inherited backoff.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const NEW = '22222222-aaaa-bbbb-cccc-000000000002'
const T0 = 1_000_000
const CONFIG = resolveConfig({}, {}).config
const GROW = CONFIG.minGrowthTokens

let clock = T0
const idle = (): MachineState => ({ ...initialState(OLD, T0, 'owner-a'), transcriptPath: fixturePath('tmp/t.jsonl') })
const turnEnd = (tokens: number, sessionId = OLD): MachineEvent => {
  clock += 1_000
  return { type: 'turnEnd', now: clock, sessionId, turnId: `t${clock}`, reason: 'answer', percent: 75, tokens, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a' }
}
const typed = (): MachineEvent => ({ type: 'typedPrompt', now: ++clock })
/** A brief writer started: the automatic run (startAutoRun) is the only one since W2b. */
const isRunStarted = (effects: Effect[]) => effects.some(e => e.type === 'startAutoRun')

describe('[medium] cancels cannot loop automatic runs', () => {
  test('N1: Cancel in every countdown, with typed prompts between: one run, then off until growth', () => {
    clock = T0
    let s = idle()
    let runs = 0
    for (let i = 0; i < 5; i++) {
      const r = step(s, turnEnd(750_000), CONFIG)
      if (isRunStarted(r.effects)) runs++
      s = r.state
      if (s.phase === 'BRIEFING') s = step(s, { type: 'cancel', now: ++clock, reason: 'button' }, CONFIG).state
      s = step(s, typed(), CONFIG).state
    }
    expect(runs).toBe(1)
    expect(isRunStarted(step(s, turnEnd(750_000 + GROW), CONFIG).effects)).toBe(true)
  })
  // N2 (another turn during every cycle: at most 3 forks, then a notice) was deleted in W2c: it
  // encoded the uncleared-fork budget (UNCLEARED_FORK_BUDGET), which the one-path design removed, and
  // a non-matching turn no longer cancels the arm (auto-run.spec pins that it does not consume it).
})

describe('[low] a fresh session after a handoff starts clean', () => {
  test('startCarrying resets failedCycles and the backoff', () => {
    clock = T0
    const dirty: MachineState = {
      ...idle(), phase: 'CLEARING', cycleId: `${OLD}#3`, clearingFrom: OLD, deadline: T0 + 30_000, briefPath: fixturePath('b.md'),
      verifiedCycleId: `${OLD}#3`, failedCycles: 1, backoffTokens: 700_000, backoffKind: 'failure',
    } as MachineState
    const carried = step(dirty, { type: 'sessionStart', now: ++clock, sessionId: NEW, source: 'clear' }, CONFIG).state
    expect(carried.phase).toBe('CARRYING')
    expect([carried.failedCycles, carried.backoffTokens, carried.backoffKind]).toEqual([0, null, null])
  })
})
