import { fixturePath } from '../fixtures/paths'

import { describe, expect, test } from 'bun:test'

import { resolveConfig, TIMEOUTS_MS } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import { initialState, recoverAfterReload, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'
import { parseState } from '../../hooks/state-file'
import { runQueued, runToGrace } from './run-path'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const NEW = '22222222-aaaa-bbbb-cccc-000000000002'
const THIRD = '33333333-aaaa-bbbb-cccc-000000000003'
const OWNER = 'owner-a'
const T0 = 1_000_000
const BRIEF = fixturePath('tmp/briefs/x.md')
const SNAPSHOT = { project: 'sample-project', verified: 'sample-project' }
const CONFIG: HandoffConfig = resolveConfig({}, {}).config

type TurnEnd = Extract<MachineEvent, { type: 'turnEnd' }>

function idle(over: Partial<MachineState> = {}): MachineState {
  return { ...initialState(OLD, T0, OWNER), transcriptPath: fixturePath('tmp/t.jsonl'), ...over }
}

function turnEnd(over: Partial<TurnEnd> = {}): TurnEnd {
  return {
    type: 'turnEnd', now: T0, sessionId: OLD, reason: 'answer', percent: 75, tokens: 750_000,
    draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'final answer', ...over,
  }
}

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

const types = (effects: Effect[]) => effects.map(e => e.type)
const logs = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [e.event] : []))
const notices = (effects: Effect[]) => effects.flatMap(e => (e.type === 'pinNotice' ? [e.text] : []))
const details = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [e.detail] : []))

function briefing(base: MachineState = idle(), sid = OLD): MachineState {
  return step(base, turnEnd({ sessionId: sid, now: base.enteredAt }), CONFIG).state
}

/** W2b: VERIFYING is gone; its place is BRIEFING with the run's brief queued for the run turn's end. */
function verifying(): MachineState {
  return runQueued(briefing(), CONFIG, T0, BRIEF, SNAPSHOT)
}

function grace(): MachineState {
  return runToGrace(briefing(), CONFIG, T0, BRIEF, SNAPSHOT)
}

function clearing(): MachineState {
  const s = grace()
  return step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, CONFIG).state
}

function carrying(): MachineState {
  const s = clearing()
  return step(s, { type: 'sessionStart', now: s.enteredAt + 100, sessionId: NEW, source: 'clear' }, CONFIG).state
}

function seeding(): MachineState {
  const s = carrying()
  return step(s, { type: 'carryDone', cycleId: s.cycleId as string, now: s.enteredAt + 10 }, CONFIG).state
}

describe('[high] reload recovery checks freshness and owner', () => {
  test('fresh CLEARING of this owner with a changed id resumes at CARRYING', () => {
    const s = clearing()
    const r = recoverAfterReload(s, NEW, OWNER, s.enteredAt + 10)
    expect(r.state.phase).toBe('CARRYING')
    expect(types(r.effects)).toContain('carryMarkers')
  })

  test('expired CLEARING resets with a notice naming the brief', () => {
    const s = clearing()
    const r = recoverAfterReload(s, NEW, OWNER, (s.deadline as number) + 3_600_000)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('carryMarkers')
    expect(notices(r.effects).some(t => t.includes(BRIEF))).toBe(true)
  })

  test('foreign-owner CLEARING resets with a notice naming the brief', () => {
    const s = clearing()
    const r = recoverAfterReload(s, NEW, 'owner-b', s.enteredAt + 10)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('carryMarkers')
    expect(notices(r.effects).some(t => t.includes(BRIEF))).toBe(true)
  })

  test('expired SEEDING does not fill the prompt box', () => {
    const s = seeding()
    const r = recoverAfterReload(s, NEW, OWNER, (s.deadline as number) + 86_400_000)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('fillSeed')
  })

  test('foreign-owner SEEDING does not fill the prompt box', () => {
    const s = seeding()
    const r = recoverAfterReload(s, NEW, 'owner-b', s.enteredAt + 1)
    expect(types(r.effects)).not.toContain('fillSeed')
  })

  test('[medium] fresh CARRYING of this owner fills the seed and pins a notice, like SEEDING', () => {
    const s = carrying()
    const r = recoverAfterReload(s, NEW, OWNER, s.enteredAt + 1)
    expect(r.state.phase).toBe('IDLE')
    expect(r.effects).toContainEqual({ type: 'fillSeed', briefPath: BRIEF })
    expect(types(r.effects)).toContain('pinNotice')
  })
})

describe('[high] session identity follows the process', () => {
  test('P5: a user /clear in IDLE rebases the session; the next cycle uses the new id', () => {
    const tired = idle({ autoChain: 1, previousSessionId: THIRD, baseTokens: 500_000 })
    const r = step(tired, { type: 'sessionStart', now: T0, sessionId: NEW, source: 'clear' }, CONFIG)
    expect(r.state.sessionId).toBe(NEW)
    expect(r.state.previousSessionId).toBeNull()
    expect(r.state.baseTokens).toBeNull()
    expect(r.state.autoChain).toBe(0)
    expect(r.state.transcriptPath).toBeNull()
    const next = run(r.state, [
      { type: 'stop', backgroundTasks: 0, sessionCrons: 0, transcriptPath: fixturePath('tmp/new.jsonl') },
      turnEnd({ sessionId: NEW, now: T0 + 5 }),
    ])
    expect(next.effects).toContainEqual({ type: 'startAutoRun', cycleId: `${NEW}#1` })
  })

  test('P6: a clear by someone else during BRIEFING aborts the cycle and rebases', () => {
    const r = step(briefing(), { type: 'sessionStart', now: T0 + 5, sessionId: NEW, source: 'clear' }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(r.state.sessionId).toBe(NEW)
    expect(types(r.effects)).not.toContain('runClear')
  })

  test('a resume (new id on SessionStart) during GRACE aborts with the band hidden', () => {
    const r = step(grace(), { type: 'sessionStart', now: T0 + 20, sessionId: NEW, source: 'resume' }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(r.state.sessionId).toBe(NEW)
    expect(types(r.effects)).toContain('hideBand')
  })

  test('a changed id on turnEnd rebases before the guards run', () => {
    const r = step(idle({ autoChain: 2 }), turnEnd({ sessionId: NEW, percent: 10, tokens: 30_000 }), CONFIG)
    expect(r.state.sessionId).toBe(NEW)
    expect(r.state.autoChain).toBe(0)
    expect(r.state.baseTokens).toBe(30_000)
  })

  test('P11: a clear that lands after the clear-timeout pins the brief path', () => {
    const c = clearing()
    const timedOut = step(c, { type: 'tick', now: c.deadline as number, isKillSwitchOn: false }, CONFIG)
    expect(notices(timedOut.effects).some(t => t.includes(BRIEF))).toBe(true)
    const late = step(timedOut.state, { type: 'sessionStart', now: (c.deadline as number) + 5_000, sessionId: NEW, source: 'clear' }, CONFIG)
    expect(late.state.sessionId).toBe(NEW)
    expect(notices(late.effects).some(t => t.includes(BRIEF))).toBe(true)
  })

  test('a clear long after a clear-timeout pins nothing', () => {
    const c = clearing()
    const timedOut = step(c, { type: 'tick', now: c.deadline as number, isKillSwitchOn: false }, CONFIG).state
    const later = (c.deadline as number) + TIMEOUTS_MS.lateClear + 1
    const r = step(timedOut, { type: 'sessionStart', now: later, sessionId: NEW, source: 'clear' }, CONFIG)
    expect(notices(r.effects)).toEqual([])
  })
})

describe('[medium] a typed prompt after the clear supersedes the seed', () => {
  test('P3: CARRYING + typed prompt + carryDone -> IDLE with the brief pinned, no submitSeed', () => {
    const s = carrying()
    const r = run(s, [
      { type: 'typedPrompt', now: s.enteredAt + 1 },
      { type: 'carryDone', cycleId: s.cycleId as string, now: s.enteredAt + 2 },
    ])
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('submitSeed')
    expect(notices(r.effects).some(t => t.includes(BRIEF))).toBe(true)
  })

  test('P4: CLEARING + typed prompt + SessionStart + carryDone -> no submitSeed', () => {
    const s = clearing()
    const r = run(s, [
      { type: 'typedPrompt', now: s.enteredAt + 1 },
      { type: 'sessionStart', now: s.enteredAt + 2, sessionId: NEW, source: 'clear' },
      { type: 'carryDone', cycleId: s.cycleId as string, now: s.enteredAt + 3 },
    ])
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('submitSeed')
    expect(types(r.effects)).toContain('carryMarkers')
  })
})

describe('[medium] turns not started by a typed prompt, and session crons', () => {
  // W2c port: BRIEFING is the skill run now; a turn that is not the run neither cancels nor consumes
  // the arm (auto-run.spec pins the binding). GRACE still cancels with the reason.
  test('a turn of another origin cancels GRACE with that reason; in BRIEFING it is skipped, not a cancel', () => {
    const r = step(grace(), { type: 'turnStart', now: T0 + 11, origin: 'other', turnId: 'x9' }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(details(r.effects)[0]).toContain('other-turn')
    for (const s of [briefing(), verifying()]) {
      const kept = step(s, { type: 'turnStart', now: T0 + 11, origin: 'other', turnId: 'x9', text: 'a cron' }, CONFIG)
      expect(kept.state).toEqual(s)
      expect(logs(kept.effects)).toEqual(['auto-run-skip-turn'])
    }
  })

  test('the own seed turn is ignored in SEEDING', () => {
    const s = seeding()
    const r = step(s, { type: 'turnStart', now: s.enteredAt + 1, origin: 'own-seed' }, CONFIG)
    expect(r.state.phase).toBe('SEEDING')
  })

  test('cancel logs its real reason', () => {
    const r = step(grace(), { type: 'cancel', now: T0 + 11, reason: 'button' }, CONFIG)
    expect(details(r.effects)[0]).toContain('button')
  })

  test('session crons from classic.Stop are a guard', () => {
    const s = step(idle(), { type: 'stop', backgroundTasks: 0, sessionCrons: 1, transcriptPath: fixturePath('tmp/t.jsonl') }, CONFIG).state
    const r = step(s, turnEnd(), CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(details(r.effects)[0].startsWith('session-crons')).toBe(true)
  })
})

describe('[medium] handoff_now interaction', () => {

  test('a completed compaction aborts BRIEFING (before and after the brief is queued) and GRACE', () => {
    for (const s of [briefing(), verifying(), grace()]) {
      const r = step(s, { type: 'compacted', now: T0 + 11, trigger: 'plugin' }, CONFIG)
      expect(r.state.phase).toBe('IDLE')
    }
  })
})

describe('[low] timing, kill switch and inputs', () => {
  test('GRACE tick far past its deadline aborts instead of clearing; a small slack still clears', () => {
    const s = grace()
    const late = step(s, { type: 'tick', now: (s.deadline as number) + 3_600_000, isKillSwitchOn: false }, CONFIG)
    expect(late.state.phase).toBe('IDLE')
    expect(types(late.effects)).not.toContain('runClear')
    const ok = step(s, { type: 'tick', now: (s.deadline as number) + 1_000, isKillSwitchOn: false }, CONFIG)
    expect(ok.state.phase).toBe('CLEARING')
  })

  // W2c port: the fork and brief-check results are gone; the same gate (gateResult) still serves the
  // clear, new-id and carry results, so the late-result rule is pinned on those.
  test('P8: a result after the phase deadline takes the timeout path', () => {
    const c = clearing()
    const r = step(c, { type: 'newIdResolved', cycleId: c.cycleId as string, now: (c.deadline as number) + 60_000, sessionId: NEW }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(logs(r.effects)).toContain('clear-timeout')
    const k = carrying()
    const rk = step(k, { type: 'carryDone', cycleId: k.cycleId as string, now: k.deadline as number }, CONFIG)
    expect(rk.state.phase).toBe('SEEDING')
    expect(logs(rk.effects)).toContain('carry-timeout')
  })

  test('P10: kill switch at a tick in CARRYING fills the seed instead of submitting it', () => {
    const s = carrying()
    const r = step(s, { type: 'tick', now: s.enteredAt + 1, isKillSwitchOn: true }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('submitSeed')
    expect(r.effects).toContainEqual({ type: 'fillSeed', briefPath: BRIEF })
  })

  test('kill switch at a tick in SEEDING ends the cycle without another submit', () => {
    const s = seeding()
    const r = step(s, { type: 'tick', now: s.enteredAt + 1, isKillSwitchOn: true }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('submitSeed')
    expect(types(r.effects)).toContain('pinNotice')
  })

  test('CARRYING resets the transcript path of the old session', () => {
    expect(carrying().transcriptPath).toBeNull()
  })

  test('clearGraceSeconds 0 is refused (floor 1)', () => {
    const r = resolveConfig({}, { CONTEXT_HANDOFF_CLEAR_GRACE_SECONDS: '0' })
    expect(r.config.clearGraceSeconds).toBe(5)
    expect(r.warnings).toHaveLength(1)
    expect(resolveConfig({}, { CONTEXT_HANDOFF_CLEAR_GRACE_SECONDS: '1' }).config.clearGraceSeconds).toBe(1)
  })

  test('seedDelivered of another cycle is dropped', () => {
    const s = seeding()
    const r = step(s, { type: 'seedDelivered', cycleId: 'other#9', now: s.enteredAt + 1 }, CONFIG)
    expect(r.state.phase).toBe('SEEDING')
    expect(logs(r.effects)).toEqual(['stale-dropped'])
    const ok = step(s, { type: 'seedDelivered', cycleId: s.cycleId as string, now: s.enteredAt + 1 }, CONFIG)
    expect(ok.state.phase).toBe('IDLE')
  })

  test('the min-growth log does not claim "since start"', () => {
    const r = step(idle({ previousSessionId: THIRD, baseTokens: 700_000 }), turnEnd({ tokens: 720_000 }), CONFIG)
    expect(details(r.effects)[0].startsWith('min-growth')).toBe(true)
    expect(details(r.effects)[0]).not.toContain('since start')
  })

  test('P13: aborted and error turn ends above the threshold are skipped with a log line', () => {
    for (const [reason, word] of [['aborted', 'turn-aborted'], ['error', 'turn-error']] as const) {
      const r = step(idle(), turnEnd({ reason }), CONFIG)
      expect(r.state.phase).toBe('IDLE')
      expect(details(r.effects)[0].startsWith(word)).toBe(true)
    }
    expect(step(idle(), turnEnd({ reason: 'aborted', percent: 10, tokens: 100_000 }), CONFIG).effects).toEqual([])
  })
})

/** One full handoff from `state` (in session `from`) into session `to`. */
function handoff(state: MachineState, from: string, to: string, now: number): MachineState {
  // Over the 400000-token default and minGrowthTokens past the session's base (W2c: was +200000 at 75%).
  const b = step(state, turnEnd({ sessionId: from, now, tokens: (state.baseTokens ?? 0) + 500_000 }), CONFIG)
  expect(b.state.phase).toBe('BRIEFING')
  const id = b.state.cycleId as string
  const v = runToGrace(b.state, CONFIG, now, BRIEF, SNAPSHOT)
  expect(v.phase).toBe('GRACE')
  const end = run(v, [
    { type: 'tick', now: v.deadline as number, isKillSwitchOn: false },
    { type: 'sessionStart', now: (v.deadline as number) + 10, sessionId: to, source: 'clear' },
  ]).state
  const done = run(end, [
    { type: 'carryDone', cycleId: id, now: end.enteredAt + 1 },
    { type: 'seedDelivered', cycleId: id, now: end.enteredAt + 2 },
    { type: 'stop', backgroundTasks: 0, sessionCrons: 0, transcriptPath: fixturePath(`tmp/${to}.jsonl`) },
    turnEnd({ sessionId: to, now: end.enteredAt + 3, percent: 20, tokens: 100_000 }),
  ]).state
  expect(done.phase).toBe('IDLE')
  return done
}

describe('[low] the auto chain through real handoffs', () => {
  test('two real handoffs block the third until a typed prompt', () => {
    const one = handoff(idle(), OLD, NEW, T0)
    expect(one.autoChain).toBe(1)
    const two = handoff(one, NEW, THIRD, T0 + 1_000_000)
    expect(two.autoChain).toBe(2)
    expect(two.previousSessionId).toBe(NEW)
    const blocked = step(two, turnEnd({ sessionId: THIRD, now: T0 + 2_000_000, tokens: 400_000 }), CONFIG)
    expect(details(blocked.effects)[0].startsWith('max-auto-chain')).toBe(true)
    const typed = run(two, [{ type: 'typedPrompt', now: T0 + 2_000_001 }, turnEnd({ sessionId: THIRD, now: T0 + 2_000_002, tokens: 400_000 })])
    expect(typed.state.phase).toBe('BRIEFING')
  })
})

describe('[low] out-of-order and no-op inputs', () => {
  test('same-cycle results in the wrong phase are logged and ignored', () => {
    const cases: Array<[MachineState, (id: string) => MachineEvent]> = [
      // W2c: the fork-result and brief-check events are gone; BRIEFING and GRACE get the clear-path results instead.
      [verifying(), id => ({ type: 'newIdResolved', cycleId: id, now: T0 + 4, sessionId: THIRD })],
      [grace(), id => ({ type: 'carryDone', cycleId: id, now: T0 + 11 })],
      [seeding(), id => ({ type: 'carryDone', cycleId: id, now: seeding().enteredAt + 1 })],
      [carrying(), id => ({ type: 'newIdResolved', cycleId: id, now: carrying().enteredAt + 1, sessionId: THIRD })],
    ]
    for (const [s, make] of cases) {
      const r = step(s, make(s.cycleId as string), CONFIG)
      expect(r.state).toEqual(s)
      expect(logs(r.effects)).toEqual(['out-of-order'])
    }
  })

  test('a clear failure reported after CLEARING is logged only', () => {
    const s = carrying()
    const r = step(s, { type: 'clearResult', cycleId: s.cycleId as string, now: s.enteredAt + 1, failure: 'x' }, CONFIG)
    expect(r.state).toEqual(s)
    expect(logs(r.effects)).toEqual(['clear-rejected'])
  })

  test('cancel is a no-op in CLEARING, CARRYING and SEEDING', () => {
    for (const s of [clearing(), carrying(), seeding()]) {
      expect(step(s, { type: 'cancel', now: s.enteredAt + 1, reason: 'button' }, CONFIG)).toEqual({ state: s, effects: [] })
    }
  })

  test('session.end in CARRYING or SEEDING drops the seed with a log line', () => {
    for (const s of [carrying(), seeding()]) {
      const r = step(s, { type: 'sessionEnd', now: s.enteredAt + 1, reason: 'exit' }, CONFIG)
      expect(r.state.phase).toBe('IDLE')
      expect(types(r.effects)).not.toContain('submitSeed')
      expect(logs(r.effects)).toEqual(['seed-abandoned'])
    }
  })

  test('seedDelivered outside SEEDING is a no-op', () => {
    const s = idle()
    expect(step(s, { type: 'seedDelivered', cycleId: `${OLD}#1`, now: T0 }, CONFIG)).toEqual({ state: s, effects: [] })
  })

  test('parseState fills fields a minimal valid file lacks', () => {
    const minimal = { version: 1, phase: 'IDLE', sessionId: OLD, cycleSeq: 3, autoChain: 1, enteredAt: T0 }
    const s = parseState(JSON.stringify(minimal)) as MachineState
    expect(s.cycleSeq).toBe(3)
    expect(s.transcriptPath).toBeNull()
    expect(s.isSuperseded).toBe(false)
    expect(s.ownerId).toBe('')
  })
})

describe('TRACK-23 retro latch carry failure holds the seed', () => {
  test('carryDone with retroFailure -> IDLE, no submitSeed, a retro notice with the brief', () => {
    const s = carrying()
    const r = step(s, { type: 'carryDone', cycleId: s.cycleId as string, now: s.enteredAt + 2, retroFailure: 'retro-gate.sh carry exit 1: boom' }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('submitSeed')
    expect(notices(r.effects).some(t => t.includes('retro latch not carried') && t.includes(BRIEF))).toBe(true)
    expect(logs(r.effects)).toContain('retro-latch-failed')
  })

  test('carryDone with retroFailure at the CARRYING deadline -> IDLE, no submitSeed', () => {
    const s = carrying()
    const r = step(s, { type: 'carryDone', cycleId: s.cycleId as string, now: s.deadline as number, retroFailure: 'retro-gate.sh carry exit 1: boom' }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('submitSeed')
    expect(logs(r.effects)).toContain('retro-latch-failed')
  })

  test('a CARRYING tick at the deadline with an unapproved retro latch -> IDLE, no submitSeed', () => {
    const s: MachineState = { ...carrying(), markers: { ...SNAPSHOT, retro: { active: true, approved: false } } }
    const r = step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('submitSeed')
    expect(notices(r.effects).some(t => t.includes('retro latch carry not confirmed') && t.includes(BRIEF))).toBe(true)
    expect(logs(r.effects)).toContain('retro-latch-timeout')
  })

  test('carryDone without retroFailure still starts seeding', () => {
    const s = carrying()
    const r = step(s, { type: 'carryDone', cycleId: s.cycleId as string, now: s.enteredAt + 2 }, CONFIG)
    expect(r.state.phase).toBe('SEEDING')
  })
})
