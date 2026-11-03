import { fixturePath } from '../fixtures/paths'

// The Plannotator review guard in the pure machine: a turn end (nudged or not) or an auto compaction
// with an open review, or an unknown review state, starts no run and charges nothing; a review that
// opens in BRIEFING, GRACE or right before the clear cancels the cycle, charged as an uncleared run.
// New behaviours were written red-first (review guards A1, A2, A4, A10, A11). The no-change
// pins (below the threshold, the nudge itself, no review, another session) pass on the old code by design.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import { guardHard, guardManual, guardTurnEnd, plannotatorRefusal } from '../../hooks/guards'
import type { TurnEndEvent } from '../../hooks/guards'
import { initialState, step } from '../../hooks/machine'
import type { MachineEvent, MachineState } from '../../hooks/machine'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const CYCLE = `${SID}#1`
const config = resolveConfig({}, {}).config
const AT = config.thresholdTokens ?? 400_000

const idle = (over: Partial<MachineState> = {}): MachineState => ({
  ...initialState(SID, 0, 'owner'), transcriptPath: fixturePath('t.jsonl'), baseTokens: AT, ...over,
})

const turnEnd = (openReviews: number | 'unknown', over: Partial<TurnEndEvent> = {}): TurnEndEvent => ({
  type: 'turnEnd', now: 1_000, sessionId: SID, turnId: 't1', reason: 'answer', answer: '',
  tokens: AT + 10_000, percent: 45, draft: '', isKillSwitchOn: false, openReviews, ...over,
})

const effectTypes = (effects: Array<{ type: string }>) => effects.map(e => e.type)
const logs = (effects: Array<{ type: string; event?: string; detail?: string }>) =>
  effects.filter(e => e.type === 'log').map(e => `${e.event} ${e.detail}`)

describe('the guard reason (kind turn: guardTurnEnd and guardHard both read it)', () => {
  test('open, unknown and none', () => {
    expect(guardTurnEnd(idle(), turnEnd(1), config)).toBe('plannotator-review-open (1)')
    expect(guardHard(idle(), turnEnd(2), config)).toBe('plannotator-review-open (2)')
    expect(guardTurnEnd(idle(), turnEnd('unknown'), config)).toBe('plannotator-state-unknown')
    expect(guardHard(idle(), turnEnd('unknown'), config)).toBe('plannotator-state-unknown')
    expect(guardTurnEnd(idle(), turnEnd(0), config)).toBeNull()
  })

  test('below the threshold stays silent even with a review open', () => {
    expect(guardTurnEnd(idle(), turnEnd(1, { tokens: AT - 1 }), config)).toBe('below-threshold')
  })

  test('guardManual (a brief is already queued) refuses only a confirmed open review', () => {
    expect(guardManual(idle(), turnEnd(1))).toBe('a Plannotator review is open')
    expect(guardManual(idle(), turnEnd('unknown'))).toBeNull()
    expect(guardManual(idle(), turnEnd(0))).toBeNull()
  })

  test('plannotatorRefusal (handoff_now before a brief) refuses with distinct texts', () => {
    expect(plannotatorRefusal(1)).toBe('a Plannotator review is open')
    expect(plannotatorRefusal('unknown')).toBe('Plannotator state is unknown')
    expect(plannotatorRefusal(0)).toBeNull()
  })
})

describe('turn end with a review open: no run, no charge', () => {
  test('no nudge: guard-skip, IDLE, no briefing, nothing charged', () => {
    const out = step(idle(), turnEnd(1), config)
    expect(out.state.phase).toBe('IDLE')
    expect(effectTypes(out.effects)).toEqual(['log'])
    expect(logs(out.effects)).toEqual(['guard-skip plannotator-review-open (1) at 45%'])
    expect([out.state.unclearedRuns, out.state.failedCycles, out.state.backoffTokens, out.state.cycleSeq]).toEqual([0, 0, null, 0])
  })

  test('unknown state: guard-skip plannotator-state-unknown', () => {
    const out = step(idle(), turnEnd('unknown'), config)
    expect(out.state.phase).toBe('IDLE')
    expect(logs(out.effects)).toEqual(['guard-skip plannotator-state-unknown at 45%'])
  })

  test('nudged (A1): guard-skip, no briefing, the nudge stays and counts the turn end, nothing charged', () => {
    const nudged = idle({ nudge: { at: 500, tokens: AT + 1, turnEnds: 0 } })
    const out = step(nudged, turnEnd(1), config)
    expect(out.state.phase).toBe('IDLE')
    expect(logs(out.effects)).toEqual(['guard-skip plannotator-review-open (1) at 45%'])
    expect(out.state.nudge).toEqual({ at: 500, tokens: AT + 1, turnEnds: 1 })
    expect([out.state.unclearedRuns, out.state.backoffTokens, out.state.cycleSeq]).toEqual([0, null, 0])
  })

  test('nudged past the ceiling: still held, and the machine asks for the held-review notice', () => {
    const nudged = idle({ nudge: { at: 500, tokens: AT + 1, turnEnds: 0 } })
    const out = step(nudged, turnEnd(1, { tokens: config.ceilingTokens + 1 }), config)
    expect(out.state.phase).toBe('IDLE')
    expect(effectTypes(out.effects)).toEqual(['log', 'reviewHeld'])
    expect(out.effects[1]).toEqual({ type: 'reviewHeld', reason: 'plannotator-review-open (1)' })
  })

  test('nudged below the ceiling and the turn limit: no notice', () => {
    const nudged = idle({ nudge: { at: 500, tokens: AT + 1, turnEnds: 0 } })
    expect(effectTypes(step(nudged, turnEnd(1), config).effects)).toEqual(['log'])
  })

  test('the nudge itself is not suppressed by an open review', () => {
    const e: MachineEvent = { type: 'contextMeasured', now: 1_000, sessionId: SID, tokens: AT + 1, percent: 41, isKillSwitchOn: false, openReviews: 1 }
    const out = step(idle(), e, config)
    expect(effectTypes(out.effects)).toContain('nudge')
  })

  test('the same turn end with no review open starts the run (no behaviour change)', () => {
    const out = step(idle(), turnEnd(0), config)
    expect(out.state.phase).toBe('BRIEFING')
    expect(effectTypes(out.effects)).toEqual(['log', 'startAutoRun'])
  })
})

describe('auto compaction with a review open (A2)', () => {
  const compact = (openReviews: number | 'unknown'): MachineEvent => ({
    type: 'compactRequested', now: 1_000, sessionId: SID, tokens: AT + 10_000, percent: 45, draft: '', isKillSwitchOn: false, openReviews,
  })

  test('logs guard-skip at auto compaction and arms nothing, so the compaction is not skipped', () => {
    const out = step(idle(), compact(1), config)
    expect(out.state.phase).toBe('IDLE')
    expect(logs(out.effects)).toEqual(['guard-skip plannotator-review-open (1) at auto compaction'])
    expect(out.state.cycleSeq).toBe(0)
  })

  test('unknown also arms nothing', () => {
    expect(logs(step(idle(), compact('unknown'), config).effects)).toEqual(['guard-skip plannotator-state-unknown at auto compaction'])
  })
})

describe('a review that opens after the cycle started cancels it (A4, A11)', () => {
  const grace = (over: Partial<MachineState> = {}): MachineState =>
    idle({ phase: 'GRACE', cycleSeq: 1, cycleId: CYCLE, deadline: 10_000, briefPath: fixturePath('b/brief.md'), verifiedCycleId: CYCLE, cycleStartTokens: AT + 10_000, ...over })
  const open = (at: 'watchdog' | 'clear', cycleId = CYCLE): MachineEvent => ({ type: 'reviewOpen', now: 2_000, cycleId, count: 1, at })

  test('GRACE (automatic): IDLE, hideBand, counts as an uncleared run, cancel backoff', () => {
    const out = step(grace(), open('watchdog'), config)
    expect(out.state.phase).toBe('IDLE')
    expect(out.state.unclearedRuns).toBe(1)
    expect(out.state.backoffKind).toBe('cancel')
    expect(out.state.backoffTokens).toBe(AT + 10_000)
    expect(effectTypes(out.effects)).toEqual(['log', 'hideBand'])
    expect(logs(out.effects)).toEqual([`cancelled ${CYCLE} GRACE: plannotator-review-open (1) at watchdog`])
  })

  test('BRIEFING after the run was called: counts as an uncleared run', () => {
    const briefing = idle({ phase: 'BRIEFING', cycleSeq: 1, cycleId: CYCLE, deadline: 10_000, cycleStartTokens: AT,
      autoRun: { calledAt: 1_500, isSubmitSeen: true, turnIds: ['t2'], isWaiting: false, isStopBlocked: false } })
    const out = step(briefing, open('watchdog'), config)
    expect([out.state.phase, out.state.unclearedRuns]).toEqual(['IDLE', 1])
  })

  test('CLEARING, from the pre-clear check: IDLE, no clear, counts as an uncleared run', () => {
    const out = step(grace({ phase: 'CLEARING', clearingFrom: SID }), open('clear'), config)
    expect([out.state.phase, out.state.unclearedRuns]).toEqual(['IDLE', 1])
    expect(effectTypes(out.effects)).not.toContain('runClear')
  })

  test('CLEARING from the watchdog, another cycle, or IDLE: no change', () => {
    const clearing = grace({ phase: 'CLEARING', clearingFrom: SID })
    expect(step(clearing, open('watchdog'), config).state).toEqual(clearing)
    expect(step(grace(), open('watchdog', `${SID}#9`), config).state).toEqual(grace())
    expect(step(idle(), open('watchdog'), config).state).toEqual(idle())
  })

  test('a manual GRACE is cancelled with no charge and a notice naming the brief', () => {
    const out = step(grace({ isManual: true }), open('watchdog'), config)
    expect([out.state.phase, out.state.unclearedRuns, out.state.backoffTokens]).toEqual(['IDLE', 0, null])
    expect(out.effects).toContainEqual({ type: 'pinNotice', text: `context-handoff: handoff cancelled: a Plannotator review is open; the brief is ${fixturePath('b/brief.md')}` })
  })
})

describe('the manual handoff with a review open', () => {
  test('the end of the turn that queued it: manual-skip with the review text, no GRACE', () => {
    const pending = idle({ manualPending: { path: fixturePath('b/m.md'), turnId: 't1', markers: null } })
    const out = step(pending, turnEnd(1), config)
    expect(out.state.phase).toBe('IDLE')
    expect(logs(out.effects)).toEqual([`manual-skip ${fixturePath('b/m.md')}: a Plannotator review is open`])
  })
})

// the run turn end read "unknown" through guardManual and
// cancelled a started cycle, charging an uncleared run. Amendment A2: unknown holds only at cycle start.
describe('an unknown read never cancels a cycle whose brief is queued (A2)', () => {
  const briefing = idle({ phase: 'BRIEFING', cycleSeq: 1, cycleId: CYCLE, deadline: 100_000, cycleStartTokens: AT,
    autoRun: { calledAt: 1_500, isSubmitSeen: true, turnIds: ['t2'], isWaiting: false, isStopBlocked: false },
    manualPending: { path: fixturePath('b/brief.md'), turnId: 't2', markers: null } })
  const runTurnEnd = (openReviews: number | 'unknown') => turnEnd(openReviews, { now: 2_000, turnId: 't2', tokens: AT + 5 })

  test('the automatic run turn end with an unknown state enters GRACE, nothing charged', () => {
    const out = step(briefing, runTurnEnd('unknown'), config)
    expect([out.state.phase, out.state.unclearedRuns, out.state.backoffTokens]).toEqual(['GRACE', 0, null])
  })

  test('the automatic run turn end with a confirmed open review cancels, counted as an uncleared run', () => {
    const out = step(briefing, runTurnEnd(1), config)
    expect([out.state.phase, out.state.unclearedRuns]).toEqual(['IDLE', 1])
    expect(logs(out.effects)).toEqual([`cancelled ${CYCLE} BRIEFING: a Plannotator review is open; the brief is ${fixturePath('b/brief.md')}`])
  })

  test('the manual turn end with an unknown state enters GRACE', () => {
    const pending = idle({ manualPending: { path: fixturePath('b/m.md'), turnId: 't1', markers: null } })
    expect(step(pending, turnEnd('unknown'), config).state.phase).toBe('GRACE')
  })
})
