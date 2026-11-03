import { DATA_ROUTE, DOMAIN_ROUTE, EXPLICIT_ROUTE } from '../fixtures/routing'

import { fixturePath } from '../fixtures/paths'

// W2e (Phase 2, User's two stages): one nudge at the threshold, the run only at a clean turn end
// after it, a ceiling that forces it (never while background tasks run), and the extractor's
// precompute reuse rule. Written red-first.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'
import { decideFactsReuse, nudgeText, PRECOMPUTE_REUSE_BYTES } from '../../hooks/nudge'
import { parseState, serializeState } from '../../hooks/state-file'
import { stopRecord } from '../../hooks/turns'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const NEW = '22222222-aaaa-bbbb-cccc-000000000002'
const T0 = 1_000_000
const CONFIG: HandoffConfig = resolveConfig({}, {}).config
const PERCENT_CONFIG: HandoffConfig = { ...CONFIG, thresholdTokens: null, thresholdPercent: 70 }

type TurnEnd = Extract<MachineEvent, { type: 'turnEnd' }>
type Measured = Extract<MachineEvent, { type: 'contextMeasured' }>

const idle = (over: Partial<MachineState> = {}): MachineState => ({ ...initialState(OLD, T0, 'owner-a'), transcriptPath: fixturePath('t.jsonl'), ...over })
const measured = (over: Partial<Measured> = {}): Measured =>
  ({ type: 'contextMeasured', now: T0, sessionId: OLD, tokens: 412_345, percent: 41, isKillSwitchOn: false, openReviews: 0, ...over })
const turnEnd = (over: Partial<TurnEnd> = {}): TurnEnd =>
  ({ type: 'turnEnd', now: T0 + 1_000, sessionId: OLD, turnId: 't1', reason: 'answer', percent: 42, tokens: 420_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a', ...over })
const logs = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [`${e.event} ${e.detail}`] : []))
const events = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [e.event] : []))
const nonLog = (effects: Effect[]) => effects.filter(e => e.type !== 'log')

function run(state: MachineState, list: MachineEvent[], config = CONFIG) {
  let current = state
  const effects: Effect[] = []
  for (const e of list) {
    const s = step(current, e, config)
    current = s.state
    effects.push(...s.effects)
  }
  return { state: current, effects }
}

const nudged = () => run(idle(), [measured()]).state

describe('config: ceilingTokens and nudgeTurnLimit', () => {
  test('defaults 500000 and 3', () => {
    const { config, warnings } = resolveConfig({}, {})
    expect(config.ceilingTokens).toBe(500_000)
    expect(config.nudgeTurnLimit).toBe(3)
    expect(warnings).toEqual([])
  })

  test('options, then env overrides', () => {
    expect(resolveConfig({ ceilingTokens: 600_000, nudgeTurnLimit: 5 }, {}).config).toMatchObject({ ceilingTokens: 600_000, nudgeTurnLimit: 5 })
    const env = { CONTEXT_HANDOFF_CEILING_TOKENS: '700000', CONTEXT_HANDOFF_NUDGE_TURN_LIMIT: '1' }
    expect(resolveConfig({ ceilingTokens: 600_000, nudgeTurnLimit: 5 }, env).config).toMatchObject({ ceilingTokens: 700_000, nudgeTurnLimit: 1 })
  })

  test('an invalid value warns and falls back', () => {
    const { config, warnings } = resolveConfig({}, { CONTEXT_HANDOFF_CEILING_TOKENS: 'lots', CONTEXT_HANDOFF_NUDGE_TURN_LIMIT: '0' })
    expect(config.ceilingTokens).toBe(500_000)
    expect(config.nudgeTurnLimit).toBe(3)
    expect(warnings).toHaveLength(2)
  })

  test('a ceiling not above the token threshold warns and becomes threshold + 100000', () => {
    const equal = resolveConfig({}, { CONTEXT_HANDOFF_THRESHOLD_TOKENS: '450000', CONTEXT_HANDOFF_CEILING_TOKENS: '450000' })
    expect(equal.config.ceilingTokens).toBe(550_000)
    expect(equal.warnings.some(w => w.includes('ceilingTokens') && w.includes('550000'))).toBe(true)
    const below = resolveConfig({ thresholdTokens: 800_000 }, {})
    expect(below.config.ceilingTokens).toBe(900_000)
    expect(below.warnings).toHaveLength(1)
  })

  test('under the percent trigger the ceiling is kept as set (no token threshold to compare)', () => {
    const { config, warnings } = resolveConfig({ thresholdPercent: 70 }, {})
    expect(config.ceilingTokens).toBe(500_000)
    expect(warnings).toEqual([])
  })
})

describe('the nudge text', () => {
  const text = nudgeText(412_345, 41)
  // The same representative routing fixtures used for the seed.
  const PEERS = ['codex', 'claude', 'gemini', 'grok', 'cursor', 'amq']
  const BRIEF_WORDS = ['codex', 'review', 'audit', 'data', 'report']

  test('exact wording: the size, finish, checkpoint, stop, and nothing else', () => {
    expect(text).toBe('Context is at 412k tokens. Finish the step in progress, reach a natural checkpoint and stop; a context handoff will follow. If Track is available, before you stop, mark each open decision that waits on the person as a waiting step in Track, with its exact note; otherwise keep it in handoff notes. Start no new background work or subagents; let the running ones finish, then end the turn.')
  })

  test('the percent form when the token count is unknown', () => {
    expect(nudgeText(undefined, 71)).toBe('Context is at 71% of the window. Finish the step in progress, reach a natural checkpoint and stop; a context handoff will follow. If Track is available, before you stop, mark each open decision that waits on the person as a waiting step in Track, with its exact note; otherwise keep it in handoff notes. Start no new background work or subagents; let the running ones finish, then end the turn.')
  })

  test('avoids every prompt-hook routing word', () => {
    expect(DATA_ROUTE.test(text)).toBe(false)
    expect(DOMAIN_ROUTE.test(text)).toBe(false)
    expect(EXPLICIT_ROUTE.test(text)).toBe(false)
    for (const word of [...PEERS, ...BRIEF_WORDS]) expect([word, text.toLowerCase().includes(word)]).toEqual([word, false])
    expect(text.includes('\n')).toBe(false)
  })
})

describe('stage 1: one nudge at the threshold', () => {
  test('a main measurement at the threshold nudges once: log nudged, the text, a precompute', () => {
    const s = step(idle(), measured(), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(s.state.nudge).toEqual({ at: T0, tokens: 412_345, turnEnds: 0 })
    expect(events(s.effects)).toEqual(['nudged'])
    expect(nonLog(s.effects)).toEqual([{ type: 'nudge', text: nudgeText(412_345, 41) }, { type: 'precomputeFacts', sessionId: OLD }])
  })

  test('a second measurement in the same window does not nudge again', () => {
    const s = step(nudged(), measured({ now: T0 + 5, tokens: 430_000 }), CONFIG)
    expect(s.effects).toEqual([])
    expect(s.state.nudge?.at).toBe(T0)
  })

  test('below the threshold, a subagent, another session, a kill switch, or a phase other than IDLE: no nudge', () => {
    const cases: Array<[string, MachineState, Measured]> = [
      ['below', idle(), measured({ tokens: 399_999 })],
      ['subagent', idle(), measured({ agentId: 'a1' })],
      ['other session', idle(), measured({ sessionId: NEW })],
      ['kill switch', idle(), measured({ isKillSwitchOn: true })],
      ['briefing', idle({ phase: 'BRIEFING', cycleId: `${OLD}#1` }), measured()],
    ]
    for (const [name, state, e] of cases) {
      const s = step(state, e, CONFIG)
      expect([name, s.state.nudge, s.effects]).toEqual([name, null, []])
    }
  })

  test('no nudge when the run could not start anyway: backoff, failure cap, uncleared cap, auto chain, min growth', () => {
    const cases: Array<[string, MachineState]> = [
      ['backoff', idle({ backoffTokens: 400_000, backoffKind: 'failure' })],
      ['failure cap', idle({ failedCycles: 2 })],
      ['uncleared cap', idle({ unclearedRuns: 3 })],
      ['auto chain', idle({ autoChain: 2 })],
      ['min growth', idle({ previousSessionId: NEW, baseTokens: 400_000 })],
    ]
    for (const [name, state] of cases) expect([name, step(state, measured(), CONFIG).state.nudge]).toEqual([name, null])
  })

  test('the percent trigger nudges at its percent', () => {
    expect(step(idle(), measured({ percent: 69 }), PERCENT_CONFIG).state.nudge).toBeNull()
    expect(step(idle(), measured({ percent: 70 }), PERCENT_CONFIG).state.nudge?.turnEnds).toBe(0)
  })
})

describe('stage 2: the run only at a clean turn end after the nudge', () => {
  test('a clean turn end after the nudge starts the run and closes the nudge window', () => {
    const s = step(nudged(), turnEnd(), CONFIG)
    expect(s.state.phase).toBe('BRIEFING')
    expect(s.state.nudge).toBeNull()
    expect(nonLog(s.effects)).toEqual([{ type: 'startAutoRun', cycleId: `${OLD}#1` }])
    expect(events(s.effects)).toEqual(['briefing'])
  })

  test('each non-clean turn end logs clean-wait <reason> and counts toward the turn limit', () => {
    const cases: Array<[string, MachineState, Partial<TurnEnd>]> = [
      ['turn-aborted', nudged(), { reason: 'aborted' }],
      ['turn-error', nudged(), { reason: 'error' }],
      ['turn-refusal', nudged(), { reason: 'refusal' }],
      ['draft-in-prompt-box', nudged(), { draft: 'half typed' }],
      ['background-tasks (1', { ...nudged(), backgroundTasks: 1 }, {}],
      ['background-tasks (2; 2 subagents', { ...nudged(), backgroundTasks: 2, runningSubagents: 2 }, {}],
      ['pending-typed-prompt', nudged(), { isTypedPending: true }],
    ]
    for (const [reason, state, over] of cases) {
      const s = step(state, turnEnd(over), CONFIG)
      expect([reason, s.state.phase, s.state.nudge?.turnEnds]).toEqual([reason, 'IDLE', 1])
      expect([reason, logs(s.effects).length, logs(s.effects)[0]?.startsWith(`clean-wait ${reason}`)]).toEqual([reason, 1, true])
    }
  })

  test('hard guards keep their guard-skip line after the nudge (crons, transcript unknown)', () => {
    const s = step({ ...nudged(), sessionCrons: 1 }, turnEnd(), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(events(s.effects)).toEqual(['guard-skip'])
  })

  test('without a nudge (no tool call crossed the threshold) a turn end is the stop itself: unchanged guards, a pending typed prompt skips', () => {
    expect(step(idle(), turnEnd(), CONFIG).state.phase).toBe('BRIEFING')
    const s = step(idle(), turnEnd({ isTypedPending: true }), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(logs(s.effects)[0]?.startsWith('guard-skip pending-typed-prompt')).toBe(true)
  })
})

describe('the ceiling', () => {
  test('at ceilingTokens the ceiling does not override a draft or a pending typed prompt: ceiling-waiting-user, no run', () => {
    const cases: Array<[string, Partial<TurnEnd>]> = [['draft-in-prompt-box', { draft: 'half typed' }], ['pending-typed-prompt', { isTypedPending: true }]]
    for (const [reason, over] of cases) {
      const s = step(nudged(), turnEnd({ ...over, tokens: 500_000 }), CONFIG)
      expect([reason, s.state.phase]).toEqual([reason, 'IDLE'])
      expect(nonLog(s.effects)).toEqual([])
      expect(logs(s.effects)).toEqual([`ceiling-waiting-user 500000 tokens >= ceiling 500000; ${reason}`])
    }
  })

  test('after nudgeTurnLimit turn ends a draft still holds the run; the first clean turn end after it starts it', () => {
    const draft = turnEnd({ draft: 'x' })
    const waited = run(nudged(), [draft, draft, draft])
    expect(waited.state.phase).toBe('IDLE')
    expect(waited.state.nudge?.turnEnds).toBe(3)
    const held = step(waited.state, draft, CONFIG)
    expect(held.state.phase).toBe('IDLE')
    expect(logs(held.effects)).toEqual(['ceiling-waiting-user 3 turn ends since the nudge (limit 3); draft-in-prompt-box'])
    expect(step(held.state, turnEnd(), CONFIG).state.phase).toBe('BRIEFING')
  })

  test('the ceiling never starts the run while background tasks (subagents included) run: ceiling-waiting-bg', () => {
    for (const bg of [{ backgroundTasks: 1, runningSubagents: 0 }, { backgroundTasks: 1, runningSubagents: 1 }]) {
      const s = step({ ...nudged(), ...bg }, turnEnd({ tokens: 600_000 }), CONFIG)
      expect(s.state.phase).toBe('IDLE')
      expect(events(s.effects)).toEqual(['ceiling-waiting-bg'])
      expect(s.state.nudge?.turnEnds).toBe(1)
    }
  })

  test('the ceiling still needs reason answer: an aborted turn end at the ceiling waits', () => {
    const s = step(nudged(), turnEnd({ tokens: 600_000, reason: 'aborted' }), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(logs(s.effects)[0]?.startsWith('clean-wait turn-aborted')).toBe(true)
  })

  test('a configured ceiling and limit are honoured in the log, and never start a run over a draft', () => {
    const config = { ...CONFIG, ceilingTokens: 450_000, nudgeTurnLimit: 1 }
    const below = step(nudged(), turnEnd({ draft: 'x', tokens: 449_999 }), config)
    expect([below.state.phase, events(below.effects)]).toEqual(['IDLE', ['clean-wait']])
    const at = step(nudged(), turnEnd({ draft: 'x', tokens: 450_000 }), config)
    expect([at.state.phase, events(at.effects)]).toEqual(['IDLE', ['ceiling-waiting-user']])
    const once = run(nudged(), [turnEnd({ draft: 'x' })], config).state
    const limit = step(once, turnEnd({ draft: 'x' }), config)
    expect([limit.state.phase, events(limit.effects)]).toEqual(['IDLE', ['ceiling-waiting-user']])
  })
})

describe('the nudge window', () => {
  test('a typed prompt keeps the nudge; a session change and a compaction close it', () => {
    expect(step(nudged(), { type: 'typedPrompt', now: T0 + 2 }, CONFIG).state.nudge?.at).toBe(T0)
    expect(step(nudged(), { type: 'sessionStart', now: T0 + 2, sessionId: NEW, source: 'clear' }, CONFIG).state.nudge).toBeNull()
    expect(step(nudged(), { type: 'compacted', now: T0 + 2, trigger: 'manual' }, CONFIG).state.nudge).toBeNull()
  })

  test('after a failed run the backoff holds the next nudge until growth; then one new nudge', () => {
    const briefing = step(nudged(), turnEnd(), CONFIG).state
    const failed = step(briefing, { type: 'autoRunFailed', cycleId: `${OLD}#1`, now: T0 + 3_000, failure: 'x' }, CONFIG).state
    expect(failed.phase).toBe('IDLE')
    expect(step(failed, measured({ tokens: 430_000 }), CONFIG).state.nudge).toBeNull()
    expect(step(failed, measured({ tokens: 520_000 }), CONFIG).state.nudge?.tokens).toBe(520_000)
  })
})

describe('W2e r2 [low]: a Stop record after the turn-end tick cancels a run not yet called', () => {
  const briefing = () => step(nudged(), turnEnd(), CONFIG).state
  const stopWith = (backgroundTasks: number, runningSubagents: number): MachineEvent =>
    ({ type: 'stop', backgroundTasks, runningSubagents, sessionCrons: 0, transcriptPath: fixturePath('t.jsonl') })

  test('background tasks or subagents in BRIEFING before auto-run-called: back to IDLE, a cancel with no backoff, the window kept', () => {
    for (const [bg, subs] of [[1, 0], [1, 1]]) {
      const s = step(briefing(), stopWith(bg, subs), CONFIG)
      expect(s.state.phase).toBe('IDLE')
      expect(s.state.cycleId).toBeNull()
      expect([s.state.backoffTokens, s.state.backoffKind, s.state.failedCycles, s.state.unclearedRuns]).toEqual([null, null, 0, 0])
      expect(s.state.nudge).toEqual({ at: T0 + 1_000, tokens: 420_000, turnEnds: 0 })
      expect(events(s.effects)).toEqual(['cancelled'])
      expect(logs(s.effects)[0]).toContain('background-tasks')
      expect(nonLog(s.effects)).toEqual([])
    }
  })

  test('the next turn end goes through the clean gate again and starts the run once the work is done', () => {
    const cancelled = step(briefing(), stopWith(1, 1), CONFIG).state
    expect(events(step(cancelled, turnEnd({ now: T0 + 5_000 }), CONFIG).effects)).toEqual(['clean-wait'])
    const done = step(cancelled, stopWith(0, 0), CONFIG).state
    expect(step(done, turnEnd({ now: T0 + 5_000 }), CONFIG).state.phase).toBe('BRIEFING')
  })

  test('after auto-run-called, or with no background work, the Stop record changes nothing in the run', () => {
    const called = step(briefing(), { type: 'autoRunCalled', cycleId: `${OLD}#1`, now: T0 + 1_020 }, CONFIG).state
    expect(step(called, stopWith(1, 0), CONFIG).state.phase).toBe('BRIEFING')
    expect(step(briefing(), stopWith(0, 0), CONFIG).state.phase).toBe('BRIEFING')
  })
})

describe('the Stop record counts running subagents', () => {
  test('background_tasks entries of type subagent', () => {
    const r = stopRecord({ background_tasks: [{ type: 'subagent' }, { type: 'shell' }, { type: 'subagent' }], transcript_path: fixturePath('t.jsonl') })
    expect(r).toMatchObject({ type: 'stop', backgroundTasks: 3, runningSubagents: 2 })
    expect(step(idle(), r as MachineEvent, CONFIG).state.runningSubagents).toBe(2)
  })
})

describe('state file', () => {
  test('the nudge window survives a reload; a corrupt or missing one reads as none', () => {
    const s = nudged()
    expect(parseState(serializeState(s))?.nudge).toEqual({ at: T0, tokens: 412_345, turnEnds: 0 })
    const raw = JSON.parse(serializeState(s))
    expect(parseState(JSON.stringify({ ...raw, nudge: { at: 'x' } }))?.nudge).toBeNull()
    const { nudge: _n, runningSubagents: _r, ...old } = raw
    const parsed = parseState(JSON.stringify(old))
    expect(parsed?.nudge).toBeNull()
    expect(parsed?.runningSubagents).toBe(0)
  })
})

describe('precompute reuse', () => {
  const cache = { sessionId: OLD, size: 1_000_000, mtimeMs: 5_000 }

  test('the bound is 256 KiB', () => {
    expect(PRECOMPUTE_REUSE_BYTES).toBe(262_144)
  })

  test('reused while the transcript grew by less than the bound', () => {
    expect(decideFactsReuse(cache, OLD, { size: 1_000_000, mtimeMs: 5_000 })).toEqual({ isReused: true, grown: 0 })
    expect(decideFactsReuse(cache, OLD, { size: 1_262_143, mtimeMs: 9_000 })).toEqual({ isReused: true, grown: 262_143 })
  })

  test('rerun at the bound, for another session, after a rewrite, or with no precompute', () => {
    expect(decideFactsReuse(cache, OLD, { size: 1_262_144, mtimeMs: 9_000 })).toEqual({ isReused: false, why: 'grew 262144 bytes (bound 262144)' })
    expect(decideFactsReuse(cache, NEW, { size: 1_000_000, mtimeMs: 5_000 })).toEqual({ isReused: false, why: 'another session' })
    expect(decideFactsReuse(cache, OLD, { size: 999_999, mtimeMs: 9_000 })).toEqual({ isReused: false, why: 'transcript rewritten' })
    expect(decideFactsReuse(cache, OLD, { size: 1_000_001, mtimeMs: 4_999 })).toEqual({ isReused: false, why: 'transcript rewritten' })
    expect(decideFactsReuse(null, OLD, { size: 1, mtimeMs: 1 })).toEqual({ isReused: false, why: 'no precompute' })
  })
})
