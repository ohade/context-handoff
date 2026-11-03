import { fixturePath } from '../fixtures/paths'

// W2f: the deferred auto-run guard in startAutoRun (register.tsx) as one pure function. The guard runs
// after the deferred callback dispatches autoRunCalled; command.run is issued only when this is true.
// Written red-first.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import { initialState, isRunCallable, step } from '../../hooks/machine'
import type { MachineEvent, MachineState } from '../../hooks/machine'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const CYCLE = `${OLD}#1`
const T0 = 1_000_000
const CONFIG: HandoffConfig = resolveConfig({}, {}).config

type TurnEnd = Extract<MachineEvent, { type: 'turnEnd' }>
type Measured = Extract<MachineEvent, { type: 'contextMeasured' }>

const idle = (over: Partial<MachineState> = {}): MachineState => ({ ...initialState(OLD, T0, 'owner-a'), transcriptPath: fixturePath('t.jsonl'), ...over })
const measured = (over: Partial<Measured> = {}): Measured =>
  ({ type: 'contextMeasured', now: T0, sessionId: OLD, tokens: 412_345, percent: 41, isKillSwitchOn: false, openReviews: 0, ...over })
const turnEnd = (over: Partial<TurnEnd> = {}): TurnEnd =>
  ({ type: 'turnEnd', now: T0 + 1_000, sessionId: OLD, turnId: 't1', reason: 'answer', percent: 42, tokens: 420_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a', ...over })
const called: MachineEvent = { type: 'autoRunCalled', cycleId: CYCLE, now: T0 + 1_020 }
const stopWith = (backgroundTasks: number, runningSubagents: number): MachineEvent =>
  ({ type: 'stop', backgroundTasks, runningSubagents, sessionCrons: 0, transcriptPath: fixturePath('t.jsonl') })

function run(state: MachineState, list: MachineEvent[]): MachineState {
  let current = state
  for (const e of list) current = step(current, e, CONFIG).state
  return current
}

/** An armed run (BRIEFING, autoRun set, not yet called), built through the real reducer. */
const armed = () => run(idle(), [measured(), turnEnd()])

describe('isRunCallable: the deferred auto-run guard', () => {
  test('a. BRIEFING, matching cycle, autoRun.calledAt set -> true', () => {
    const s = run(armed(), [called])
    expect(s.phase).toBe('BRIEFING')
    expect(s.cycleId).toBe(CYCLE)
    expect(s.autoRun?.calledAt).toBe(T0 + 1_020)
    expect(isRunCallable(s, CYCLE)).toBe(true)
  })

  test('b. the cycle ended before the call: a Stop record reporting background work, then the deferred autoRunCalled -> false', () => {
    for (const [bg, subs] of [[1, 0], [1, 1]] as const) {
      const s = run(armed(), [stopWith(bg, subs), called])
      expect(s.phase).toBe('IDLE')
      expect(isRunCallable(s, CYCLE)).toBe(false)
    }
  })

  test('b. a Stop record after autoRunCalled leaves the run callable (W2e r2: only a run not yet called is cancelled)', () => {
    const s = run(armed(), [called, stopWith(1, 0)])
    expect(s.phase).toBe('BRIEFING')
    expect(isRunCallable(s, CYCLE)).toBe(true)
  })

  test('b. BRIEFING with a different cycle id -> false', () => {
    const s = run(armed(), [called])
    expect(isRunCallable(s, `${OLD}#2`)).toBe(false)
  })

  test('c. BRIEFING, matching cycle, autoRun null -> false', () => {
    const s: MachineState = { ...run(armed(), [called]), autoRun: null }
    expect(s.phase).toBe('BRIEFING')
    expect(isRunCallable(s, CYCLE)).toBe(false)
  })

  test('c. BRIEFING, matching cycle, autoRun.calledAt null -> false', () => {
    const s = armed()
    expect(s.phase).toBe('BRIEFING')
    expect(s.cycleId).toBe(CYCLE)
    expect(s.autoRun).not.toBeNull()
    expect(s.autoRun?.calledAt).toBeNull()
    expect(isRunCallable(s, CYCLE)).toBe(false)
  })

  test('not BRIEFING (GRACE), matching cycle, autoRun.calledAt set -> false (the phase clause alone)', () => {
    const s: MachineState = { ...run(armed(), [called]), phase: 'GRACE' }
    expect(s.cycleId).toBe(CYCLE)
    expect(s.autoRun?.calledAt).toBe(T0 + 1_020)
    expect(isRunCallable(s, CYCLE)).toBe(false)
  })

  test('outside BRIEFING (IDLE) -> false', () => {
    expect(isRunCallable(idle(), CYCLE)).toBe(false)
  })
})
