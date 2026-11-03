import { fixturePath } from '../fixtures/paths'

// A built-in compaction re-arms automatic handoff: the failure cap, the uncleared-run cap and the
// backoff reset on `compacted`, after any cancel the compaction causes. Within one context the caps
// still block. Namespace imports so a missing export fails its own test, not the file.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import * as guards from '../../hooks/guards'
import * as machine from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'

const { initialState, step } = machine
const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const T0 = 1_000_000
const CYCLE = `${SID}#1`
const CONFIG: HandoffConfig = { ...resolveConfig({}, {}).config, thresholdTokens: 5_000 }
const COMPACTED: MachineEvent = { type: 'compacted', now: T0 + 60, trigger: 'auto' }
const RESET_WORDING = 'off until the next compaction or session'

function run(state: MachineState, events: MachineEvent[]) {
  let current = state
  const effects: Effect[] = []
  for (const e of events) {
    const s = step(current, e, CONFIG)
    current = s.state
    effects.push(...s.effects)
  }
  return { state: current, effects }
}
const logs = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [`${e.event} ${e.detail}`] : []))
const notices = (effects: Effect[]) => effects.flatMap(e => (e.type === 'pinNotice' ? [e.text] : []))
const turnEndEvent = (over: Partial<guards.TurnEndEvent> = {}): guards.TurnEndEvent =>
  ({ type: 'turnEnd', now: T0 + 100, sessionId: SID, turnId: 't9', reason: 'answer', percent: 12, tokens: 120_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a', ...over })
const idle = (over: Partial<MachineState> = {}): MachineState => ({ ...initialState(SID, T0, 'owner-a'), transcriptPath: fixturePath('t.jsonl'), ...over })
const armed = (s: MachineState) => run(s, [turnEndEvent({ turnId: 't1', now: T0 })]).state
const called = (s: MachineState) => run(armed(s), [{ type: 'autoRunCalled', cycleId: `${SID}#${s.cycleSeq + 1}`, now: T0 + 20 }]).state
const capFields = (s: MachineState) => ({ failedCycles: s.failedCycles, unclearedRuns: s.unclearedRuns, backoffTokens: s.backoffTokens, backoffKind: s.backoffKind })
const CLEARED = { failedCycles: 0, unclearedRuns: 0, backoffTokens: null, backoffKind: null }

describe('compaction resets the caps', () => {
  test('uncleared-run-cap: blocks before, compaction clears it, the same crossing then passes the cap guards', () => {
    const capped = idle({ unclearedRuns: 3 })
    expect(guards.guardNudge(capped, turnEndEvent(), CONFIG)).toStartWith('uncleared-run-cap (')
    const after = run(capped, [COMPACTED]).state
    expect(capFields(after)).toEqual(CLEARED)
    expect(guards.guardNudge(after, turnEndEvent(), CONFIG)).toBeNull()
    const next = run(after, [turnEndEvent()])
    expect(next.state.phase).not.toBe('IDLE')
    expect(logs(next.effects).some(l => l.startsWith('guard-skip'))).toBe(false)
  })

  test('failure-cap: blocks before (with its failure backoff), compaction clears both, the crossing then passes', () => {
    const capped = idle({ failedCycles: 2, backoffTokens: 200_000, backoffKind: 'failure' })
    expect(guards.guardNudge(capped, turnEndEvent(), CONFIG)).toStartWith('failure-cap (')
    const after = run(capped, [COMPACTED]).state
    expect(capFields(after)).toEqual(CLEARED)
    expect(guards.guardNudge(after, turnEndEvent(), CONFIG)).toBeNull()
    expect(run(after, [turnEndEvent()]).state.phase).not.toBe('IDLE')
  })

  test('a started run in flight: cancelled with reason compacted as today, then the counters and backoff are reset', () => {
    const inFlight = called(idle({ unclearedRuns: 2 }))
    expect(inFlight.phase).toBe('BRIEFING')
    expect(inFlight.autoRun?.calledAt).not.toBeNull()
    const out = run(inFlight, [COMPACTED])
    expect(out.state.phase).toBe('IDLE')
    expect(logs(out.effects).some(l => l.startsWith('cancelled') && l.includes('compacted (auto)'))).toBe(true)
    expect(capFields(out.state)).toEqual(CLEARED)
    expect(out.state.nudge).toBeNull()
  })

  test('a non-cancellable phase is not cancelled; only the counters and backoff reset', () => {
    const clearing = idle({ phase: 'CLEARING', cycleId: CYCLE, cycleSeq: 1, clearingFrom: SID, briefPath: fixturePath('b.md'), deadline: T0 + 99_000, unclearedRuns: 2, failedCycles: 1, backoffTokens: 50_000, backoffKind: 'cancel' })
    const out = run(clearing, [COMPACTED])
    expect(out.state.phase).toBe('CLEARING')
    expect(out.state.cycleId).toBe(CYCLE)
    expect(logs(out.effects).some(l => l.startsWith('cancelled'))).toBe(false)
    expect(capFields(out.state)).toEqual(CLEARED)
  })

  test('compaction does not reset autoChain', () => {
    expect(run(idle({ autoChain: 2, unclearedRuns: 3 }), [COMPACTED]).state.autoChain).toBe(2)
  })
})

describe('the caps still apply within one context', () => {
  test('three uncleared runs with no compaction trip the cap; the notice and the guard name the new rule', () => {
    const third = run(called(idle({ unclearedRuns: 2 })), [{ type: 'typedPrompt', now: T0 + 50 }])
    expect(third.state.unclearedRuns).toBe(3)
    expect(notices(third.effects).some(t => t.includes(RESET_WORDING))).toBe(true)
    const reason = guards.guardNudge({ ...third.state, backoffTokens: null, backoffKind: null }, turnEndEvent(), CONFIG)
    expect(reason).toStartWith('uncleared-run-cap (3 ')
    expect(reason).toContain(RESET_WORDING)
  })

  test('two failed cycles trip the failure cap; the notice and the guard name the new rule', () => {
    const second = run(called(idle({ failedCycles: 1 })), [{ type: 'tick', now: T0 + 10_000_000, isKillSwitchOn: false }])
    expect(second.state.failedCycles).toBe(2)
    expect(notices(second.effects).some(t => t.includes(RESET_WORDING))).toBe(true)
    const reason = guards.guardNudge({ ...second.state, backoffTokens: null, backoffKind: null }, turnEndEvent(), CONFIG)
    expect(reason).toStartWith('failure-cap (2 ')
    expect(reason).toContain(RESET_WORDING)
  })

  test('a typed prompt still does not lift a failure backoff', () => {
    const out = run(idle({ backoffTokens: 200_000, backoffKind: 'failure' }), [{ type: 'typedPrompt', now: T0 + 50 }]).state
    expect(out.backoffKind).toBe('failure')
    expect(out.backoffTokens).toBe(200_000)
  })
})
