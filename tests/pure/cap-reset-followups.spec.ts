import { fixturePath } from '../fixtures/paths'

// Follow-ups to the compaction cap reset: a compaction that cancels a started run pins no cap
// notice (it re-arms the caps in the same step), the cap wording counts from the last compaction,
// and every compaction trigger resets the counters and the backoff. Namespace imports so a missing
// export fails its own test, not the file.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import * as guards from '../../hooks/guards'
import * as machine from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'

const { initialState, step } = machine
const SID = '11111111-aaaa-4bbb-8ccc-000000000002'
const T0 = 1_000_000
const CONFIG: HandoffConfig = { ...resolveConfig({}, {}).config, thresholdTokens: 5_000 }
const UNCLEARED_NOTICE = 'automatic runs ended without a clear'
const FAILED_NOTICE = 'handoff attempts failed'
const RESET_WORDING = 'off until the next compaction or session'
const OLD_WORDING = 'in this session'

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

describe('a compaction that cancels the third uncleared run pins no cap notice', () => {
  test('the cancel log stays, the cap notice is dropped, and the count is 0', () => {
    const inFlight = called(idle({ unclearedRuns: 2 }))
    expect(inFlight.phase).toBe('BRIEFING')
    expect(inFlight.autoRun?.calledAt).not.toBeNull()
    const out = run(inFlight, [{ type: 'compacted', now: T0 + 60, trigger: 'auto' }])
    expect(notices(out.effects).filter(t => t.includes(UNCLEARED_NOTICE) || t.includes(FAILED_NOTICE))).toEqual([])
    expect(logs(out.effects).some(l => l.startsWith('cancelled') && l.includes('compacted (auto)'))).toBe(true)
    expect(out.state.unclearedRuns).toBe(0)
  })
})

describe('the cap wording counts from the last compaction', () => {
  test('a third typed-prompt cancel in one context still pins the uncleared-run notice, without "in this session"', () => {
    const third = run(called(idle({ unclearedRuns: 2 })), [{ type: 'typedPrompt', now: T0 + 50 }])
    const capNotices = notices(third.effects).filter(t => t.includes(UNCLEARED_NOTICE))
    expect(capNotices).toHaveLength(1)
    expect(capNotices[0]).not.toContain(OLD_WORDING)
    expect(capNotices[0]).toContain(RESET_WORDING)
  })

  test('a second failed cycle still pins the failure notice, without "in this session"', () => {
    const second = run(called(idle({ failedCycles: 1 })), [{ type: 'tick', now: T0 + 10_000_000, isKillSwitchOn: false }])
    const capNotices = notices(second.effects).filter(t => t.includes(FAILED_NOTICE))
    expect(capNotices).toHaveLength(1)
    expect(capNotices[0]).not.toContain(OLD_WORDING)
    expect(capNotices[0]).toContain(RESET_WORDING)
  })

  test('the guard reasons at the caps keep their prefixes and drop "in this session"', () => {
    const failure = guards.guardNudge(idle({ failedCycles: 2 }), turnEndEvent(), CONFIG)
    expect(failure).toStartWith('failure-cap (')
    expect(failure).not.toContain(OLD_WORDING)
    expect(failure).toContain(RESET_WORDING)
    const uncleared = guards.guardNudge(idle({ unclearedRuns: 3 }), turnEndEvent(), CONFIG)
    expect(uncleared).toStartWith('uncleared-run-cap (')
    expect(uncleared).not.toContain(OLD_WORDING)
    expect(uncleared).toContain(RESET_WORDING)
  })
})

describe('every compaction trigger resets the counters and the backoff', () => {
  for (const trigger of ['manual', 'plugin']) {
    test(`trigger ${trigger}`, () => {
      const capped = idle({ failedCycles: 2, unclearedRuns: 3, backoffTokens: 200_000, backoffKind: 'failure' })
      expect(capFields(run(capped, [{ type: 'compacted', now: T0 + 60, trigger }]).state)).toEqual(CLEARED)
    })
  }
})
