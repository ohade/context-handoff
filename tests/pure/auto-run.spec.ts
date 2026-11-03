import { fixturePath } from '../fixtures/paths'

// W2b Phase 1: the automatic run is the skill run. Binding:
// auto-run-called, then resolve, then the own prompt.submit "/context-handoff:compact-crafter automatic-run cycle=…",
// then turn.start whose text is the expanded <command-message>context-handoff:compact-crafter</command-message> markup.
import { describe, expect, test } from 'bun:test'

import { resolveConfig, TIMEOUTS_MS } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import { FAILED_CYCLE_CAP } from '../../hooks/guards'
import { initialState, isAutoRunTurn, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'
import { parseState, serializeState } from '../../hooks/state-file'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const T0 = 1_000_000
const CYCLE = `${OLD}#1`
const MARKUP = `<command-message>context-handoff:compact-crafter</command-message>\n<command-name>/context-handoff:compact-crafter</command-name>\n<command-args>automatic-run cycle=${CYCLE} session=${OLD}</command-args>`
const CONFIG: HandoffConfig = { ...resolveConfig({}, {}).config, thresholdTokens: 5_000 }
const RUN_MS = CONFIG.autoRunTimeoutSeconds * 1000

type TurnEnd = Extract<MachineEvent, { type: 'turnEnd' }>
const turnEnd = (over: Partial<TurnEnd> = {}): TurnEnd =>
  ({ type: 'turnEnd', now: T0, sessionId: OLD, turnId: 't1', reason: 'answer', percent: 12, tokens: 120_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a', ...over })
const logs = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [e.event] : []))
const idle = (over: Partial<MachineState> = {}): MachineState => ({ ...initialState(OLD, T0, 'owner-a'), transcriptPath: fixturePath('t.jsonl'), ...over })

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

const armed = () => run(idle(), [turnEnd()]).state
const called = () => run(armed(), [{ type: 'autoRunCalled', cycleId: CYCLE, now: T0 + 20 }]).state
/** The live order: called, (resolve: no event), own prompt.submit, then turn.start own-skill. */
const bound = () => run(called(), [
  { type: 'autoRunSubmit', cycleId: CYCLE, now: T0 + 101 },
  { type: 'turnStart', now: T0 + 380, origin: 'own-skill', turnId: 't2', text: MARKUP },
]).state

describe('the trigger starts the skill run', () => {
  test('a turn end over the threshold enters BRIEFING with the run deadline and one startAutoRun', () => {
    const s = step(idle(), turnEnd(), CONFIG)
    expect(s.state.phase).toBe('BRIEFING')
    expect(s.state.deadline).toBe(T0 + RUN_MS)
    expect(s.effects.filter(e => e.type !== 'log')).toEqual([{ type: 'startAutoRun', cycleId: CYCLE }])
    expect(s.state.autoRun).toEqual({ calledAt: null, isSubmitSeen: false, turnIds: [], isWaiting: false, isStopBlocked: false })
  })

  test('the run deadline counts from auto-run-called', () => {
    expect(called().deadline).toBe(T0 + 20 + RUN_MS)
  })
})

describe('binding (pins)', () => {
  test('live order: the own prompt.submit then the own-skill turn.start binds that turn', () => {
    const s = bound()
    expect(s.autoRun?.turnIds).toEqual(['t2'])
    expect(isAutoRunTurn(s, 't2')).toBe(true)
    expect(isAutoRunTurn(s, 't1')).toBe(false)
  })

  test('an own-skill turn whose text lacks the command markup does not bind (cross-check)', () => {
    const s = run(called(), [
      { type: 'autoRunSubmit', cycleId: CYCLE, now: T0 + 101 },
      { type: 'turnStart', now: T0 + 380, origin: 'own-skill', turnId: 't2', text: 'something else' },
    ])
    expect(s.state.autoRun?.turnIds).toEqual([])
    expect(logs(s.effects)).toContain('auto-run-skip-turn')
  })

  test('a non-matching turn first (a cron, another plugin) does not consume the arm; the run turn after it binds', () => {
    const s = run(called(), [
      { type: 'turnStart', now: T0 + 50, origin: 'other', turnId: 'cron1', text: 'scheduled check' },
      { type: 'turnEnd', now: T0 + 60, sessionId: OLD, turnId: 'cron1', reason: 'answer', percent: 12, tokens: 120_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'x' },
      { type: 'autoRunSubmit', cycleId: CYCLE, now: T0 + 101 },
      { type: 'turnStart', now: T0 + 380, origin: 'own-skill', turnId: 't2', text: MARKUP },
    ])
    expect(s.state.phase).toBe('BRIEFING')
    expect(s.state.autoRun?.turnIds).toEqual(['t2'])
  })

  test('fallback without the prompt.submit: a turn whose text carries the markup binds; plain text does not', () => {
    const plain = run(called(), [{ type: 'turnStart', now: T0 + 300, origin: 'other', turnId: 'tx', text: 'hello' }]).state
    expect(plain.autoRun?.turnIds).toEqual([])
    const s = run(plain, [{ type: 'turnStart', now: T0 + 400, origin: 'other', turnId: 't2', text: MARKUP }]).state
    expect(s.autoRun?.turnIds).toEqual(['t2'])
  })

  test('a turn before auto-run-called never binds', () => {
    const s = run(armed(), [{ type: 'turnStart', now: T0 + 5, origin: 'other', turnId: 't2', text: MARKUP }]).state
    expect(s.autoRun?.turnIds).toEqual([])
  })

  test('a prompt.submit for another cycle is ignored', () => {
    const s = run(called(), [{ type: 'autoRunSubmit', cycleId: `${OLD}#9`, now: T0 + 101 }]).state
    expect(s.autoRun?.isSubmitSeen).toBe(false)
  })

  test('arm expiry: no bound turn by the deadline is a failed run (failure backoff, counts to the cap)', () => {
    const s = step(called(), { type: 'tick', now: T0 + 20 + RUN_MS, isKillSwitchOn: false }, CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(logs(s.effects)).toEqual(['auto-run-timeout'])
    expect([s.state.failedCycles, s.state.backoffKind]).toEqual([1, 'failure'])
  })

  test('a composer prompt during the arm cancels and charges nothing', () => {
    const s = step(bound(), { type: 'typedPrompt', now: T0 + 500 }, CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(logs(s.effects)).toEqual(['cancelled'])
    expect([s.state.failedCycles, s.state.backoffTokens, s.state.backoffKind]).toEqual([0, null, null])
  })
})

describe('the armed door and the run end', () => {
  const brief = (turnId: string): MachineEvent => ({ type: 'manualBrief', now: T0 + 20_000, path: fixturePath('briefs/b.md'), turnId, markers: null })

  test('a brief from the bound turn is queued; at that turn end the run enters GRACE (charged as automatic)', () => {
    const queued = step(bound(), brief('t2'), CONFIG)
    expect(logs(queued.effects)).toEqual(['auto-queued'])
    const ended = step(queued.state, turnEnd({ turnId: 't2', now: T0 + 30_000 }), CONFIG)
    expect(ended.state.phase).toBe('GRACE')
    expect(ended.state.isManual).toBe(false)
    expect(ended.state.briefPath).toBe(fixturePath('briefs/b.md'))
    expect(ended.state.triggerTurnId).toBe('t2')
    expect(ended.effects.some(e => e.type === 'showGrace')).toBe(true)
  })

  test('a brief from any other turn is refused', () => {
    const s = step(bound(), brief('t9'), CONFIG)
    expect(s.state.manualPending).toBeNull()
    expect(logs(s.effects)).toEqual(['manual-refused'])
  })

  test('the bound turn ends without a brief: a short wait, then a failure', () => {
    const ended = step(bound(), turnEnd({ turnId: 't2', now: T0 + 30_000 }), CONFIG)
    expect(ended.state.phase).toBe('BRIEFING')
    expect(ended.state.autoRun?.isWaiting).toBe(true)
    expect(ended.state.deadline).toBe(T0 + 30_000 + TIMEOUTS_MS.autoRunContinuation)
    const failed = step(ended.state, { type: 'tick', now: T0 + 30_000 + TIMEOUTS_MS.autoRunContinuation, isKillSwitchOn: false }, CONFIG)
    expect(logs(failed.effects)).toEqual(['auto-run-timeout'])
    expect(failed.state.failedCycles).toBe(1)
  })

  test('a Stop-gate block keeps the run: the continuation turn binds and may hand off', () => {
    const s = run(bound(), [
      { type: 'cancel', now: T0 + 29_000, reason: 'stop-blocked' },
      turnEnd({ turnId: 't2', now: T0 + 30_000 }),
      { type: 'turnStart', now: T0 + 30_500, origin: 'other', turnId: 't3', text: '', isPrompted: false },
      brief('t3'),
      turnEnd({ turnId: 't3', now: T0 + 40_000 }),
    ])
    expect(s.state.phase).toBe('GRACE')
  })

  test('a typed prompt after the bound turn ended without a brief is a failure, not a free cancel', () => {
    const ended = step(bound(), turnEnd({ turnId: 't2', now: T0 + 30_000 }), CONFIG).state
    const s = step(ended, { type: 'typedPrompt', now: T0 + 31_000 }, CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(s.state.failedCycles).toBe(1)
  })

  test('autoRunFailed (tool cap, rejected call) is a failure; at the cap a notice is pinned', () => {
    const s = step({ ...bound(), failedCycles: FAILED_CYCLE_CAP - 1 }, { type: 'autoRunFailed', cycleId: CYCLE, now: T0 + 9_000, failure: 'tool cap 15 reached' }, CONFIG)
    expect(logs(s.effects)).toContain('auto-run-failed')
    expect(s.state.failedCycles).toBe(FAILED_CYCLE_CAP)
    expect(s.effects.some(e => e.type === 'pinNotice')).toBe(true)
  })

  test('the bound turn ending aborted is a failure at once', () => {
    const s = step(bound(), turnEnd({ turnId: 't2', reason: 'aborted', now: T0 + 30_000 }), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(s.state.failedCycles).toBe(1)
  })
})

describe('session.compact trigger auto', () => {
  type Compact = Extract<MachineEvent, { type: 'compactRequested' }>
  const compact = (over: Partial<Compact> = {}): Compact =>
    ({ type: 'compactRequested', now: T0, sessionId: OLD, percent: 95, tokens: 950_000, draft: '', isKillSwitchOn: false, openReviews: 0, ...over })

  test('in IDLE with guards passing it arms the run once', () => {
    const s = step(idle(), compact(), CONFIG)
    expect(s.state.phase).toBe('BRIEFING')
    expect(s.effects.filter(e => e.type !== 'log')).toEqual([{ type: 'startAutoRun', cycleId: CYCLE }])
    expect(logs(s.effects)).toContain('armed-by-compaction')
  })

  test('a failure backoff lets the next auto compaction run (no second arm)', () => {
    const s = step(idle({ backoffTokens: 940_000, backoffKind: 'failure' }), compact(), CONFIG)
    expect(s.state.phase).toBe('IDLE')
  })

  test('outside IDLE it never arms', () => {
    expect(step(bound(), compact(), CONFIG).state.cycleId).toBe(CYCLE)
  })
})

describe('TRACK-25 U4: the run records how it ended (lastRunEnd)', () => {
  test('a fresh state has no run end', () => {
    expect(initialState(OLD, T0, 'owner-a').lastRunEnd).toBeNull()
  })

  test('a tick past the run deadline records the cycle, its turns, the event and the time', () => {
    const at = T0 + 20 + RUN_MS
    const s = step(bound(), { type: 'tick', now: at, isKillSwitchOn: false }, CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(s.state.lastRunEnd).toEqual({ cycleId: CYCLE, turnIds: ['t2'], event: 'auto-run-timeout', at })
  })

  test('another abort of a started run records its own event', () => {
    const s = step(bound(), { type: 'autoRunFailed', cycleId: CYCLE, now: T0 + 9_000, failure: 'tool cap 15 reached' }, CONFIG)
    expect(s.state.lastRunEnd).toEqual({ cycleId: CYCLE, turnIds: ['t2'], event: 'auto-run-failed', at: T0 + 9_000 })
  })

  test('an abort before the run started records nothing', () => {
    const s = step(armed(), { type: 'typedPrompt', now: T0 + 5 }, CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(s.state.lastRunEnd).toBeNull()
  })

  test('the state file keeps a valid run end; an old file without one and a malformed one load as null', () => {
    const ended = step(bound(), { type: 'tick', now: T0 + 20 + RUN_MS, isKillSwitchOn: false }, CONFIG).state
    expect(parseState(serializeState(ended))?.lastRunEnd).toEqual({ cycleId: CYCLE, turnIds: ['t2'], event: 'auto-run-timeout', at: T0 + 20 + RUN_MS })
    const { lastRunEnd: _, ...old } = ended
    expect(parseState(JSON.stringify(old))?.lastRunEnd).toBeNull()
    for (const bad of [
      'x', 7, [], { cycleId: CYCLE, turnIds: 't2', event: 'auto-run-timeout', at: 1 },
      { cycleId: CYCLE, turnIds: [2], event: 'auto-run-timeout', at: 1 }, { cycleId: CYCLE, turnIds: ['t2'], event: 5, at: 1 },
      { cycleId: CYCLE, turnIds: ['t2'], event: 'auto-run-timeout', at: Number.NaN }, { turnIds: ['t2'], event: 'auto-run-timeout', at: 1 },
    ]) {
      const parsed = parseState(JSON.stringify({ ...ended, lastRunEnd: bad }))
      expect(parsed).not.toBeNull()
      expect(parsed?.lastRunEnd).toBeNull()
    }
  })
})

describe('TRACK-25 U4 polish: run-end pins', () => {
  const timedOut = () => step(bound(), { type: 'tick', now: T0 + 20 + RUN_MS, isKillSwitchOn: false }, CONFIG).state

  test('a raw state file whose run end has "at":1e999 loads the run end as null', () => {
    const text = JSON.stringify({ ...timedOut(), lastRunEnd: { cycleId: CYCLE, turnIds: ['t2'], event: 'auto-run-timeout', at: 123_456_789 } })
    const raw = text.replace('"at":123456789', '"at":1e999')
    expect(raw).toContain('"at":1e999')
    const parsed = parseState(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.lastRunEnd).toBeNull()
  })

  test('an ended run, then a cycle that aborts before its run started, keeps the earlier run end', () => {
    const ended = timedOut()
    const record = ended.lastRunEnd
    expect(record).not.toBeNull()
    // 110k tokens of growth past the failed cycle's start lifts its backoff: a later cycle arms.
    const rearmed = step(ended, turnEnd({ turnId: 't3', now: T0 + 30 + RUN_MS, tokens: 230_000, percent: 23 }), CONFIG).state
    expect(rearmed.phase).toBe('BRIEFING')
    expect(rearmed.cycleId).toBe(`${OLD}#2`)
    const aborted = step(rearmed, { type: 'typedPrompt', now: T0 + 40 + RUN_MS }, CONFIG).state
    expect(aborted.phase).toBe('IDLE')
    expect(aborted.lastRunEnd).toEqual(record)
  })

  test('a GRACE abort of a started run records the run end', () => {
    const grace = run(bound(), [
      { type: 'manualBrief', now: T0 + 20_000, path: fixturePath('briefs/b.md'), turnId: 't2', markers: null },
      turnEnd({ turnId: 't2', now: T0 + 30_000 }),
    ]).state
    expect(grace.phase).toBe('GRACE')
    const s = step(grace, { type: 'typedPrompt', now: T0 + 31_000 }, CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(s.state.lastRunEnd).toMatchObject({ cycleId: CYCLE, at: T0 + 31_000 })
  })
})
