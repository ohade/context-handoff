import { fixturePath } from '../fixtures/paths'

import { describe, expect, test } from 'bun:test'

import { resolveConfig, TIMEOUTS_MS } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import { guardTurnEnd } from '../../hooks/guards'
import {
  AUTO_RUN_MARKUP,
  initialState,
  recoverAfterReload,
  shouldVetoCompaction,
  step,
} from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState, Phase } from '../../hooks/machine'
import { parseState } from '../../hooks/state-file'
import { RUN_TURN, runQueued, runToGrace } from './run-path'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const NEW = '22222222-aaaa-bbbb-cccc-000000000002'
const T0 = 1_000_000
const OWNER = 'owner-a'
const BRIEF = fixturePath('tmp/briefs/x.md')
const SNAPSHOT = { project: 'sample-project', verified: 'sample-project' }

const CONFIG: HandoffConfig = resolveConfig({}, {}).config
const INITIAL_CONFIG: HandoffConfig = { ...CONFIG, seedVia: 'initial' }
/** The percent trigger ("whichever is set": a percent replaces the token default). */
const PERCENT_CONFIG: HandoffConfig = { ...CONFIG, thresholdTokens: null, thresholdPercent: 70 }

function idle(over: Partial<MachineState> = {}): MachineState {
  return { ...initialState(OLD, T0, OWNER), transcriptPath: fixturePath('tmp/t.jsonl'), ...over }
}

function turnEnd(over: Partial<Extract<MachineEvent, { type: 'turnEnd' }>> = {}): MachineEvent {
  return { type: 'turnEnd', now: T0, sessionId: OLD, reason: 'answer', percent: 75, tokens: 750_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'final answer', ...over }
}

function types(effects: Effect[]): string[] {
  return effects.map(e => e.type)
}

function logEvents(effects: Effect[]): string[] {
  return effects.flatMap(e => (e.type === 'log' ? [e.event] : []))
}

/** Runs events in order and returns the final step plus every effect seen. */
function run(state: MachineState, events: MachineEvent[], config: HandoffConfig = CONFIG) {
  let current = state
  const all: Effect[] = []
  for (const e of events) {
    const s = step(current, e, config)
    current = s.state
    all.push(...s.effects)
  }
  return { state: current, effects: all }
}

function inBriefing(): MachineState {
  return step(idle(), turnEnd(), CONFIG).state
}

function cycle(state: MachineState): string {
  return state.cycleId as string
}

/** W2b: VERIFYING is gone; its place is BRIEFING with the run's brief queued for the run turn's end. */
function inVerifying(): MachineState {
  return runQueued(inBriefing(), CONFIG, T0, BRIEF, SNAPSHOT)
}

function inGrace(): MachineState {
  return runToGrace(inBriefing(), CONFIG, T0, BRIEF, SNAPSHOT)
}

function inClearing(): MachineState {
  const s = inGrace()
  return step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, CONFIG).state
}

function inCarrying(): MachineState {
  const s = inClearing()
  return step(s, { type: 'sessionStart', now: T0 + 20_000, sessionId: NEW, source: 'clear' }, CONFIG).state
}

function inSeeding(config: HandoffConfig = CONFIG): MachineState {
  const s = inCarrying()
  return step(s, { type: 'carryDone', cycleId: cycle(s), now: T0 + 21_000 }, config).state
}

describe('happy path', () => {
  // W2c port: the fork-era steps (facts, fork result, marker snapshot, brief check; VERIFYING) are
  // replaced by the skill run in the live order; the phases after the brief are unchanged.
  test('IDLE -> BRIEFING (the skill run) -> GRACE -> CLEARING -> CARRYING -> SEEDING -> IDLE, in order', () => {
    const phases: Phase[] = []
    const effectsSeen: string[] = []
    let s = idle()
    const record = (e: MachineEvent) => {
      const r = step(s, e, CONFIG)
      s = r.state
      phases.push(s.phase)
      effectsSeen.push(...types(r.effects).filter(t => t !== 'log'))
    }
    record(turnEnd({ turnId: 't1' }))
    const id = cycle(s)
    expect(id).toBe(`${OLD}#1`)
    expect(s.deadline).toBe(T0 + 180_000)
    record({ type: 'autoRunCalled', cycleId: id, now: T0 + 1 })
    expect(s.deadline).toBe(T0 + 1 + 180_000)
    record({ type: 'autoRunSubmit', cycleId: id, now: T0 + 2 })
    record({ type: 'turnStart', now: T0 + 3, origin: 'own-skill', turnId: 'run', text: `${AUTO_RUN_MARKUP}\n<command-args>automatic-run cycle=${id} session=${OLD}</command-args>` })
    record({ type: 'manualBrief', now: T0 + 3, path: BRIEF, turnId: 'run', markers: SNAPSHOT })
    record(turnEnd({ turnId: 'run', now: T0 + 4 }))
    expect(s.deadline).toBe(T0 + 4 + 5_000)
    record({ type: 'tick', now: T0 + 4 + 4_999, isKillSwitchOn: false })
    record({ type: 'tick', now: T0 + 4 + 5_000, isKillSwitchOn: false })
    record({ type: 'clearResult', cycleId: id, now: T0 + 5_010 })
    record({ type: 'sessionEnd', now: T0 + 5_020, reason: 'clear' })
    record({ type: 'sessionStart', now: T0 + 5_030, sessionId: NEW, source: 'clear' })
    record({ type: 'carryDone', cycleId: id, now: T0 + 5_040 })
    record({ type: 'seedDelivered', cycleId: id, now: T0 + 5_050 })

    expect(phases).toEqual([
      'BRIEFING', 'BRIEFING', 'BRIEFING', 'BRIEFING', 'BRIEFING', 'GRACE', 'GRACE', 'CLEARING',
      'CLEARING', 'CLEARING', 'CARRYING', 'SEEDING', 'IDLE',
    ])
    expect(effectsSeen).toEqual([
      'startAutoRun', 'showGrace',
      'hideBand', 'runClear', 'pollNewId', 'carryMarkers', 'submitSeed',
    ])
    expect(s.sessionId).toBe(NEW)
    expect(s.previousSessionId).toBe(OLD)
    expect(s.autoChain).toBe(1)
    expect(s.baseTokens).toBeNull()
    expect(s.cycleId).toBeNull()
    expect(s.deadline).toBeNull()
  })

  test('carryMarkers hands over the snapshot taken before the clear, old and new id', () => {
    const r = step(inClearing(), { type: 'sessionStart', now: T0, sessionId: NEW, source: 'clear' }, CONFIG)
    expect(r.effects).toContainEqual({
      type: 'carryMarkers', cycleId: `${OLD}#1`, fromSessionId: OLD, toSessionId: NEW, snapshot: SNAPSHOT,
    })
  })

  test('submitSeed names the verified brief', () => {
    const s = inCarrying()
    const r = step(s, { type: 'carryDone', cycleId: cycle(s), now: T0 }, CONFIG)
    expect(r.effects).toContainEqual({ type: 'submitSeed', cycleId: `${OLD}#1`, briefPath: BRIEF, via: 'submit' })
    expect(r.state.deadline).toBe(T0 + TIMEOUTS_MS.seed)
  })
})

describe('guards are no-ops with one log line', () => {
  // W2c: the default trigger is 400000 tokens; the percent cases run under the percent trigger they were
  // written for (PERCENT_CONFIG), and the token trigger gets its own "tokens unknown" case.
  const cases: Array<[string, MachineState, MachineEvent, string, HandoffConfig?]> = [
    ['kill switch', idle(), turnEnd({ isKillSwitchOn: true }), 'kill-switch'],
    ['tokens unknown', idle(), turnEnd({ tokens: undefined }), 'tokens-unknown'],
    ['percent unknown', idle(), turnEnd({ percent: undefined }), 'percent-unknown', PERCENT_CONFIG],
    ['max auto chain', idle({ autoChain: 2 }), turnEnd(), 'max-auto-chain'],
    ['fresh session grew too little', idle({ previousSessionId: OLD, baseTokens: 700_000 }), turnEnd({ tokens: 799_999 }), 'min-growth'],
    ['fresh session base unknown', idle({ previousSessionId: OLD }), turnEnd({ tokens: undefined }), 'min-growth', PERCENT_CONFIG],
    ['draft in the prompt box', idle(), turnEnd({ draft: '  half typed' }), 'draft-in-prompt-box'],
    ['background tasks running', idle({ backgroundTasks: 1 }), turnEnd(), 'background-tasks'],
    ['transcript unknown', idle({ transcriptPath: null }), turnEnd(), 'transcript-unknown'],
  ]
  for (const [name, state, event, reason, config = CONFIG] of cases) {
    test(name, () => {
      const r = step(state, event, config)
      expect(r.state.phase).toBe('IDLE')
      expect(r.state.cycleId).toBeNull()
      expect(types(r.effects)).toEqual(['log'])
      const only = r.effects[0] as Extract<Effect, { type: 'log' }>
      expect(only.event).toBe('guard-skip')
      expect(only.detail.startsWith(reason)).toBe(true)
    })
  }

  test('below the threshold is silent (tokens, and percent when a percent is set)', () => {
    const r = step(idle(), turnEnd({ tokens: 399_999 }), CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(r.effects).toEqual([])
    const p = step(idle(), turnEnd({ percent: 69 }), PERCENT_CONFIG)
    expect(p.state.phase).toBe('IDLE')
    expect(p.effects).toEqual([])
  })

  test('exactly at the threshold starts a cycle', () => {
    expect(step(idle(), turnEnd({ tokens: 400_000 }), CONFIG).state.phase).toBe('BRIEFING')
    expect(step(idle(), turnEnd({ percent: 70, tokens: 1 }), PERCENT_CONFIG).state.phase).toBe('BRIEFING')
  })

  test('a subagent turn end is ignored silently', () => {
    const r = step(idle(), turnEnd({ agentId: 'agent-1' }), CONFIG)
    expect(r.state).toEqual(idle())
    expect(r.effects).toEqual([])
  })

  test('a turn end outside IDLE starts nothing', () => {
    const s = inGrace()
    const r = step(s, turnEnd(), CONFIG)
    expect(r.state.phase).toBe('GRACE')
    expect(r.effects).toEqual([])
  })

  test('autoChain one below the max still runs', () => {
    expect(step(idle({ autoChain: 1 }), turnEnd(), CONFIG).state.phase).toBe('BRIEFING')
  })

  test('min growth applies only to sessions a handoff created', () => {
    expect(step(idle({ baseTokens: 740_000 }), turnEnd({ tokens: 750_000 }), CONFIG).state.phase).toBe('BRIEFING')
    const grown = idle({ previousSessionId: OLD, baseTokens: 600_000 })
    expect(step(grown, turnEnd({ tokens: 700_000 }), CONFIG).state.phase).toBe('BRIEFING')
  })

  test('the first known token count becomes the base', () => {
    const r = step(idle({ previousSessionId: OLD }), turnEnd({ percent: 10, tokens: 42_000 }), CONFIG)
    expect(r.state.baseTokens).toBe(42_000)
    expect(step(r.state, turnEnd({ percent: 10, tokens: 90_000 }), CONFIG).state.baseTokens).toBe(42_000)
  })

  test('guardTurnEnd orders kill switch before percent', () => {
    const e = turnEnd({ isKillSwitchOn: true, percent: undefined }) as Extract<MachineEvent, { type: 'turnEnd' }>
    expect(guardTurnEnd(idle(), e, CONFIG)).toBe('kill-switch')
  })

  test('classic.Stop records background tasks and the transcript; a subagent Stop is ignored', () => {
    const s = step(idle(), { type: 'stop', backgroundTasks: 3, sessionCrons: 0, transcriptPath: fixturePath('x.jsonl') }, CONFIG).state
    expect(s.backgroundTasks).toBe(3)
    expect(s.transcriptPath).toBe(fixturePath('x.jsonl'))
    const sub = step(s, { type: 'stop', backgroundTasks: 0, sessionCrons: 0, transcriptPath: fixturePath('y.jsonl'), agentId: 'a' }, CONFIG).state
    expect(sub).toEqual(s)
  })
})

describe('timeouts (watchdog tick)', () => {
  // W2c port: the fork timeout (240 s, "still bills") is gone; BRIEFING is the skill run with its
  // own deadline, autoRunTimeoutSeconds (180 s), and its timeout is a failure.
  test('BRIEFING: 180 s aborts to IDLE as a failed run', () => {
    const s = inBriefing()
    expect(step(s, { type: 'tick', now: T0 + 179_999, isKillSwitchOn: false }, CONFIG).state.phase).toBe('BRIEFING')
    const r = step(s, { type: 'tick', now: T0 + 180_000, isKillSwitchOn: false }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(logEvents(r.effects)).toEqual(['auto-run-timeout'])
    expect([r.state.backoffKind, r.state.failedCycles]).toEqual(['failure', 1])
  })

  test('BRIEFING honours a configured run timeout', () => {
    const cfg = { ...CONFIG, autoRunTimeoutSeconds: 60 }
    const s = step(idle(), turnEnd(), cfg).state
    expect(s.deadline).toBe(T0 + 60_000)
  })

  test('BRIEFING with the brief queued: the run deadline still aborts to IDLE', () => {
    const s = inVerifying()
    const r = step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(logEvents(r.effects)).toEqual(['auto-run-timeout'])
  })

  test('GRACE: the deadline proceeds to CLEARING with a deferred clear', () => {
    const s = inGrace()
    const r = step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, CONFIG)
    expect(r.state.phase).toBe('CLEARING')
    expect(r.state.clearingFrom).toBe(OLD)
    expect(r.state.deadline).toBe((s.deadline as number) + TIMEOUTS_MS.clear)
    expect(types(r.effects)).toEqual(['hideBand', 'log', 'runClear'])
  })

  test('GRACE honours clearGraceSeconds', () => {
    const s = inVerifying()
    const r = step(s, turnEnd({ turnId: RUN_TURN, now: T0 + 50 }), { ...CONFIG, clearGraceSeconds: 9 })
    expect(r.state.phase).toBe('GRACE')
    expect(r.state.deadline).toBe(T0 + 50 + 9_000)
  })

  test('CLEARING: 30 s resets with a pinned notice', () => {
    const s = inClearing()
    const r = step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).toEqual(['log', 'pinNotice'])
    expect(logEvents(r.effects)).toEqual(['clear-timeout'])
  })

  test('CARRYING: timeout continues to SEEDING with a notice', () => {
    const s = inCarrying()
    const r = step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, CONFIG)
    expect(r.state.phase).toBe('SEEDING')
    expect(types(r.effects)).toEqual(['log', 'pinNotice', 'log', 'submitSeed'])
  })

  test('SEEDING: timeout keeps delivery unknown and pins the brief, then IDLE', () => {
    const s = inSeeding()
    const r = step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).toEqual(['log', 'pinNotice'])
    expect(JSON.stringify(r.effects)).toContain('delivery unknown')
    expect(JSON.stringify(r.effects)).toContain(BRIEF)
  })

  test('SEEDING via initial: timeout cannot retry an uncertain initial delivery', () => {
    const s = inSeeding(INITIAL_CONFIG)
    expect(s.seedVia).toBe('initial')
    expect(s.deadline).toBe(T0 + 21_000 + TIMEOUTS_MS.seedInitialFallback)
    const fb = step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, INITIAL_CONFIG)
    expect(fb.state.phase).toBe('IDLE')
    expect(types(fb.effects)).toEqual(['log', 'pinNotice'])
    expect(JSON.stringify(fb.effects)).toContain('delivery unknown')
    expect(JSON.stringify(fb.effects)).toContain(BRIEF)
  })

  test('a tick in IDLE does nothing', () => {
    expect(step(idle(), { type: 'tick', now: T0 * 2, isKillSwitchOn: true }, CONFIG)).toEqual({ state: idle(), effects: [] })
  })

  test('the kill switch at a tick aborts BRIEFING (with or without a queued brief) and GRACE, not CLEARING', () => {
    for (const s of [inBriefing(), inVerifying(), inGrace()]) {
      const r = step(s, { type: 'tick', now: T0, isKillSwitchOn: true }, CONFIG)
      expect(r.state.phase).toBe('IDLE')
    }
    const c = inClearing()
    expect(step(c, { type: 'tick', now: c.enteredAt, isKillSwitchOn: true }, CONFIG).state.phase).toBe('CLEARING')
  })
})

describe('failures abort to IDLE and leave compaction alone', () => {
  test('a failed automatic run, before or after the brief is queued', () => {
    // W2c port: the fork and facts failures are gone with the fork path (an extractor or snapshot
    // failure now refuses handoff_now before anything is queued); the run's failures take their place.
    for (const s of [inBriefing(), inVerifying()]) {
      const r = step(s, { type: 'autoRunFailed', cycleId: cycle(s), now: T0 + 5, failure: 'command.run rejected: x' }, CONFIG)
      expect(r.state.phase).toBe('IDLE')
      expect(logEvents(r.effects)).toEqual(['auto-run-failed'])
      expect(shouldVetoCompaction(r.state, 'auto', undefined)).toBe(false)
      expect(types(r.effects)).not.toContain('runClear')
      expect(r.state.verifiedCycleId).toBeNull()
    }
  })

  test('clear rejected resets with a notice', () => {
    const s = inClearing()
    const r = step(s, { type: 'clearResult', cycleId: cycle(s), now: T0, failure: 'unknown command' }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).toEqual(['log', 'pinNotice'])
  })

  test('SessionStart with the old id polls; an unchanged id after 5 s resets', () => {
    const s = inClearing()
    const p = step(s, { type: 'sessionStart', now: T0, sessionId: OLD, source: 'clear' }, CONFIG)
    expect(p.state.phase).toBe('CLEARING')
    expect(p.effects).toContainEqual({ type: 'pollNewId', cycleId: `${OLD}#1`, oldSessionId: OLD, withinMs: 5_000 })
    const miss = step(p.state, { type: 'newIdResolved', cycleId: cycle(s), now: T0, sessionId: null }, CONFIG)
    expect(miss.state.phase).toBe('IDLE')
    const same = step(p.state, { type: 'newIdResolved', cycleId: cycle(s), now: T0, sessionId: OLD }, CONFIG)
    expect(same.state.phase).toBe('IDLE')
    const hit = step(p.state, { type: 'newIdResolved', cycleId: cycle(s), now: T0, sessionId: NEW }, CONFIG)
    expect(hit.state.phase).toBe('CARRYING')
    expect(hit.state.sessionId).toBe(NEW)
  })

  test('carry failure continues to SEEDING with a notice', () => {
    const s = inCarrying()
    const r = step(s, { type: 'carryDone', cycleId: cycle(s), now: T0, failure: 'different projects' }, CONFIG)
    expect(r.state.phase).toBe('SEEDING')
    expect(types(r.effects)).toEqual(['log', 'pinNotice', 'log', 'submitSeed'])
  })
})

describe('veto of built-in compaction', () => {
  test('only in GRACE and CLEARING with the current cycle verified brief', () => {
    const states: Array<[string, MachineState, boolean]> = [
      ['IDLE', idle(), false],
      ['BRIEFING', inBriefing(), false],
      ['BRIEFING+brief', inVerifying(), false],
      ['GRACE', inGrace(), true],
      ['CLEARING', inClearing(), true],
      ['CARRYING', inCarrying(), false],
      ['SEEDING', inSeeding(), false],
    ]
    for (const [phase, s, expected] of states) {
      expect([phase, shouldVetoCompaction(s, 'auto', undefined)]).toEqual([phase, expected])
    }
  })

  test('a brief verified for an older cycle does not veto', () => {
    const s = { ...inGrace(), verifiedCycleId: `${OLD}#0` }
    expect(shouldVetoCompaction(s, 'auto', undefined)).toBe(false)
  })

  test('precompute is vetoed; a manual /compact, a plugin compaction and a subagent compaction pass', () => {
    const s = inGrace()
    expect(shouldVetoCompaction(s, 'precompute', undefined)).toBe(true)
    expect(shouldVetoCompaction(s, 'manual', undefined)).toBe(false)
    expect(shouldVetoCompaction(s, 'plugin', undefined)).toBe(false)
    expect(shouldVetoCompaction(s, 'auto', 'agent-1')).toBe(false)
  })

  test('after any abort the veto is gone', () => {
    const s = inGrace()
    const cancelled = step(s, { type: 'cancel', now: T0, reason: 'button' }, CONFIG).state
    expect(shouldVetoCompaction(cancelled, 'auto', undefined)).toBe(false)
    const c = inClearing()
    const timedOut = step(c, { type: 'tick', now: c.deadline as number, isKillSwitchOn: false }, CONFIG).state
    expect(shouldVetoCompaction(timedOut, 'auto', undefined)).toBe(false)
  })
})

describe('cycle identity', () => {
  // W2c: "a late fork result after the timeout is dropped and logged as billed" was deleted with the
  // fork path (late-fork billing); the run's own late events are pinned below.
  test('run events of cycle 1 are dropped while cycle 2 is briefing', () => {
    const s1 = inBriefing()
    const back = step(s1, { type: 'cancel', now: T0, reason: 'button' }, CONFIG).state
    // The cancel backs off (backoff.spec.ts); cycle 2 starts after minGrowthTokens of growth.
    const s2 = step(back, turnEnd({ now: T0 + 1, tokens: 750_000 + CONFIG.minGrowthTokens }), CONFIG).state
    expect(cycle(s2)).toBe(`${OLD}#2`)
    for (const e of [
      { type: 'autoRunCalled', cycleId: `${OLD}#1`, now: T0 + 2 },
      { type: 'autoRunSubmit', cycleId: `${OLD}#1`, now: T0 + 2 },
      { type: 'autoRunFailed', cycleId: `${OLD}#1`, now: T0 + 2, failure: 'old' },
    ] as MachineEvent[]) {
      const r = step(s2, e, CONFIG)
      expect([e.type, r.state]).toEqual([e.type, s2])
    }
  })

  test('stale clear, carry and id results are dropped', () => {
    const s = inGrace()
    for (const e of [
      { type: 'clearResult', failure: 'x' },
      { type: 'carryDone' },
      { type: 'newIdResolved', sessionId: NEW },
    ]) {
      const r = step(s, { ...e, cycleId: 'other#9', now: T0 } as MachineEvent, CONFIG)
      expect(r.state).toEqual(s)
      expect(logEvents(r.effects)[0]).toBe('stale-dropped')
    }
  })
})

describe('cancellation before the clear', () => {
  test('a typed prompt cancels BRIEFING (with or without a queued brief) and GRACE and resets the chain', () => {
    for (const s of [inBriefing(), inVerifying(), inGrace()]) {
      const r = step({ ...s, autoChain: 1 }, { type: 'typedPrompt', now: T0 }, CONFIG)
      expect(r.state.phase).toBe('IDLE')
      expect(r.state.autoChain).toBe(0)
      expect(types(r.effects)).not.toContain('runClear')
    }
    const g = step(inGrace(), { type: 'typedPrompt', now: T0 }, CONFIG)
    expect(types(g.effects)).toEqual(['log', 'hideBand'])
  })

  test('a typed prompt after the clear was issued does not cancel it', () => {
    const r = step(inClearing(), { type: 'typedPrompt', now: T0 }, CONFIG)
    expect(r.state.phase).toBe('CLEARING')
  })

  test('a typed prompt in IDLE resets the auto chain', () => {
    expect(step(idle({ autoChain: 2 }), { type: 'typedPrompt', now: T0 }, CONFIG).state.autoChain).toBe(0)
  })

  test('a typed prompt during SEEDING ends the cycle and pins the brief path', () => {
    const r = step(inSeeding(), { type: 'typedPrompt', now: T0 }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(r.state.autoChain).toBe(0)
    expect(types(r.effects)).toEqual(['log', 'pinNotice'])
  })

  test('Cancel aborts GRACE with the band hidden', () => {
    const r = step(inGrace(), { type: 'cancel', now: T0, reason: 'button' }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).toEqual(['log', 'hideBand'])
  })

  test('session.end cancels before the clear; reason clear in CLEARING is expected', () => {
    expect(step(inBriefing(), { type: 'sessionEnd', now: T0, reason: 'exit' }, CONFIG).state.phase).toBe('IDLE')
    expect(step(inGrace(), { type: 'sessionEnd', now: T0, reason: 'clear' }, CONFIG).state.phase).toBe('IDLE')
    expect(step(inClearing(), { type: 'sessionEnd', now: T0, reason: 'clear' }, CONFIG).state.phase).toBe('CLEARING')
    expect(step(inClearing(), { type: 'sessionEnd', now: T0, reason: 'exit' }, CONFIG).state.phase).toBe('IDLE')
  })

  test('a SessionStart(clear) the mod did not cause rebases on the new session', () => {
    const r = step(idle(), { type: 'sessionStart', now: T0, sessionId: NEW, source: 'clear' }, CONFIG)
    expect(r.state.sessionId).toBe(NEW)
    expect(r.state.phase).toBe('IDLE')
    expect(logEvents(r.effects)).toEqual(['session-change'])
  })

  test('a chain of two handoffs without a typed prompt blocks the third', () => {
    const afterOne = run(inSeeding(), [{ type: 'seedDelivered', cycleId: `${OLD}#1`, now: T0 }]).state
    expect(afterOne.autoChain).toBe(1)
    const blocked = step({ ...afterOne, autoChain: 2 }, turnEnd({ sessionId: NEW }), CONFIG)
    expect(logEvents(blocked.effects)).toEqual(['guard-skip'])
  })
})

describe('hot reload recovery', () => {
  test('CLEARING with a changed session id resumes at CARRYING', () => {
    const r = recoverAfterReload(inClearing(), NEW, OWNER, T0 + 50)
    expect(r.state.phase).toBe('CARRYING')
    expect(r.state.sessionId).toBe(NEW)
    expect(r.state.deadline).toBe(T0 + 50 + TIMEOUTS_MS.carry)
    expect(r.effects).toContainEqual({
      type: 'carryMarkers', cycleId: `${OLD}#1`, fromSessionId: OLD, toSessionId: NEW, snapshot: SNAPSHOT,
    })
  })

  test('CLEARING with the same id resets to IDLE and keeps the brief path visible', () => {
    const r = recoverAfterReload(inClearing(), OLD, OWNER, T0)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).toEqual(['log', 'pinNotice'])
  })

  test('every other state resets to IDLE', () => {
    for (const s of [inBriefing(), inVerifying(), inGrace()]) {
      const r = recoverAfterReload(s, NEW, OWNER, T0)
      expect(r.state.phase).toBe('IDLE')
      expect(logEvents(r.effects)).toEqual(['reload-reset'])
    }
  })

  test('SEEDING resets to IDLE with delivery unknown and a visible brief', () => {
    const r = recoverAfterReload(inSeeding(), NEW, OWNER, T0)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).toEqual(['log', 'pinNotice'])
    expect(JSON.stringify(r.effects)).toContain('delivery unknown')
    expect(JSON.stringify(r.effects)).toContain(BRIEF)
  })

  test('IDLE stays as it was', () => {
    expect(recoverAfterReload(idle(), NEW, OWNER, T0)).toEqual({ state: idle(), effects: [] })
  })
})

describe('persisted state', () => {
  test('round-trips through JSON', () => {
    const s = inClearing()
    expect(parseState(JSON.stringify(s))).toEqual(s)
  })

  test('garbage, foreign shapes and other versions read as absent', () => {
    expect(parseState('{')).toBeNull()
    expect(parseState('null')).toBeNull()
    expect(parseState(JSON.stringify({ phase: 'IDLE' }))).toBeNull()
    expect(parseState(JSON.stringify({ ...idle(), version: 2 }))).toBeNull()
    expect(parseState(JSON.stringify({ ...idle(), phase: 'WAITING' }))).toBeNull()
  })
})
