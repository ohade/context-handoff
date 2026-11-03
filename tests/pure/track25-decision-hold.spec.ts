import { fixturePath } from '../fixtures/paths'

// TRACK-25 U1 + U2: the nudge asks for a Track waiting row, and an open 👉 decision with no waiting
// row holds the automatic run for at most nudgeTurnLimit turn ends. Written red-first.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import { FAILED_CYCLE_CAP, UNCLEARED_RUN_CAP } from '../../hooks/guards'
import { coveredItems, decisionHoldReason, decisionText, hasDecisionLine, NOTES_ONLY, waitingRowsOf } from '../../hooks/decision-hold'
import { initialState, needsDecisionCheck, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'
import { nudgeText } from '../../hooks/nudge'
import type { PendingItem } from '../../hooks/pending-items'
import type { TrackCheckpoint } from '../../hooks/track-contract'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const T0 = 1_000_000
const CONFIG: HandoffConfig = resolveConfig({}, {}).config
const DECISION = 'Two options.\n👉 Reply go or no.'
const ASK = 'If Track is available, before you stop, mark each open decision that waits on the person as a waiting step in Track, with its exact note; otherwise keep it in handoff notes.'
const HOLD = 'clean-wait decision-unregistered'

type TurnEnd = Extract<MachineEvent, { type: 'turnEnd' }>
type Measured = Extract<MachineEvent, { type: 'contextMeasured' }>

const idle = (over: Partial<MachineState> = {}): MachineState => ({ ...initialState(OLD, T0, 'owner-a'), transcriptPath: fixturePath('t.jsonl'), ...over })
const measured = (over: Partial<Measured> = {}): Measured =>
  ({ type: 'contextMeasured', now: T0, sessionId: OLD, tokens: 412_345, percent: 41, isKillSwitchOn: false, openReviews: 0, ...over })
const turnEnd = (over: Partial<TurnEnd> = {}): TurnEnd =>
  ({ type: 'turnEnd', now: T0 + 1_000, sessionId: OLD, turnId: 't1', reason: 'answer', percent: 42, tokens: 420_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a', ...over })
const held = (over: Partial<TurnEnd> = {}): TurnEnd => turnEnd({ answer: DECISION, waitingRows: 0, ...over })
const logs = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [`${e.event} ${e.detail}`] : []))
const events = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [e.event] : []))
const ofType = <T extends Effect['type']>(effects: Effect[], type: T) => effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type)

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
const checkpoint = (rows: NonNullable<TrackCheckpoint['open_steps']> | undefined): TrackCheckpoint =>
  ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: rows?.length ?? 0 }, ...(rows === undefined ? {} : { open_steps: rows }) })

describe('U1: the nudge asks for a waiting row', () => {
  test('the ask follows the existing sentence', () => {
    expect(nudgeText(412_345, 41)).toBe(`Context is at 412k tokens. Finish the step in progress, reach a natural checkpoint and stop; a context handoff will follow. ${ASK} Start no new background work or subagents; let the running ones finish, then end the turn.`)
  })

  test('the ask avoids the peer verbs and the words user, task and paused', () => {
    const PEER_VERBS = /(talk|discuss|consult|ask|route|coordinate|sync|work[\s]+with|use|instruct|tell|delegate|send)/i
    const text = nudgeText(412_345, 41)
    expect(text.match(PEER_VERBS)).toBeNull()
    for (const word of ['user', 'task', 'paused']) expect([word, text.toLowerCase().includes(word)]).toEqual([word, false])
  })
})

describe('U2: the decision line and the check', () => {
  test('hasDecisionLine: a line-start 👉, after list or bold markup; not mid-line', () => {
    for (const text of ['👉 go?', '  👉 x', '- 👉 x', '**👉 x', 'a\n👉 b']) expect([text, hasDecisionLine(text)]).toEqual([text, true])
    expect(hasDecisionLine('see 👉 here')).toBe(false)
  })

  test('decisionText: the answer, else the same-session last response', () => {
    const last = { sessionId: OLD, turnId: 't0', text: DECISION }
    expect(decisionText(idle({ lastResponse: last }), turnEnd({ answer: 'now' }))).toBe('now')
    expect(decisionText(idle({ lastResponse: last }), turnEnd({ answer: '' }))).toBe(DECISION)
    expect(decisionText(idle({ lastResponse: { ...last, sessionId: 'other' } }), turnEnd({ answer: '' }))).toBe('')
  })

  test('needsDecisionCheck: a clean 👉 turn end at the threshold; not a draft, a background task, or below threshold', () => {
    expect(needsDecisionCheck(nudged(), held(), CONFIG)).toBe(true)
    expect(needsDecisionCheck(idle(), held(), CONFIG)).toBe(true)
    expect(needsDecisionCheck(nudged(), held({ draft: 'half typed' }), CONFIG)).toBe(false)
    expect(needsDecisionCheck({ ...nudged(), backgroundTasks: 1 }, held(), CONFIG)).toBe(false)
    expect(needsDecisionCheck(nudged(), held({ tokens: 120_000, percent: 12 }), CONFIG)).toBe(false)
    expect(needsDecisionCheck(nudged(), turnEnd(), CONFIG)).toBe(false)
  })

  test('needsDecisionCheck: false whenever the machine skips this turn end anyway', () => {
    expect(needsDecisionCheck(nudged(), held({ isKillSwitchOn: true }), CONFIG)).toBe(false)
    expect(needsDecisionCheck(idle(), held({ isKillSwitchOn: true }), CONFIG)).toBe(false)
    expect(needsDecisionCheck({ ...nudged(), failedCycles: FAILED_CYCLE_CAP }, held(), CONFIG)).toBe(false)
    expect(needsDecisionCheck({ ...idle(), failedCycles: FAILED_CYCLE_CAP }, held(), CONFIG)).toBe(false)
    expect(needsDecisionCheck(nudged(), held({ openReviews: 1 }), CONFIG)).toBe(false)
    expect(needsDecisionCheck(idle(), held({ openReviews: 1 }), CONFIG)).toBe(false)
    expect(needsDecisionCheck({ ...nudged(), sessionCrons: 1 }, held(), CONFIG)).toBe(false)
  })

  test('decisionHoldReason: 0 or unknown waiting rows hold; absent Track and a waiting row do not', () => {
    expect(decisionHoldReason(nudged(), held())).toBe('decision-unregistered')
    expect(decisionHoldReason(nudged(), held({ waitingRows: 'unknown' }))).toBe('decision-unregistered')
    expect(decisionHoldReason(nudged(), held({ waitingRows: 'absent' }))).toBeNull()
    expect(decisionHoldReason(nudged(), held({ waitingRows: 1 }))).toBeNull()
    expect(decisionHoldReason(nudged(), turnEnd({ waitingRows: 0 }))).toBeNull()
  })

  test('waitingRowsOf: absent Track, an inventory-less receipt is unknown, else the waiting count', () => {
    expect(waitingRowsOf(null)).toBe('absent')
    expect(waitingRowsOf(checkpoint(undefined))).toBe('unknown')
    expect(waitingRowsOf(checkpoint([]))).toBe(0)
    expect(waitingRowsOf(checkpoint([{ id: 'plan:1', status: 'waiting', subject: 's' }, { id: 'plan:2', status: 'pending', subject: 's' }]))).toBe(1)
  })
})

describe('U2: the bounded hold', () => {
  test('a nudged 👉 turn end with no waiting row stays IDLE, re-arms the nudge once and pins why', () => {
    const s = step(nudged(), held(), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(s.state.nudge?.turnEnds).toBe(1)
    expect(logs(s.effects)).toContain(`${HOLD} (turn end 1 since the nudge)`)
    expect(ofType(s.effects, 'nudge')).toEqual([{ type: 'nudge', text: nudgeText(420_000, 42), rearmedWindow: T0 }])
    expect(events(s.effects)).toContain('nudge-rearmed')
    expect(ofType(s.effects, 'startAutoRun')).toEqual([])
    expect(ofType(s.effects, 'pinNotice')).toHaveLength(1)
    expect(ofType(s.effects, 'pinNotice')[0]?.text).toContain('waiting step in Track')
  })

  test('the second and third held turn ends only advance the counter', () => {
    // register.tsx passes the window (nudge.at) whose one re-arm it already delivered.
    const first = step(nudged(), held(), CONFIG).state
    const second = step(first, held({ turnId: 't2', rearmedWindow: T0 }), CONFIG)
    const third = step(second.state, held({ turnId: 't3', rearmedWindow: T0 }), CONFIG)
    for (const [n, s] of [[2, second], [3, third]] as const) {
      expect(s.state.phase).toBe('IDLE')
      expect(s.state.nudge?.turnEnds).toBe(n)
      expect(logs(s.effects)).toContain(`${HOLD} (turn end ${n} since the nudge)`)
      expect(ofType(s.effects, 'nudge')).toEqual([])
      expect(events(s.effects)).not.toContain('nudge-rearmed')
    }
  })

  test('the first held end re-arms once whatever came before it; a second held end does not', () => {
    const afterDraft = step(nudged(), turnEnd({ draft: 'half typed' }), CONFIG).state
    const first = step(afterDraft, held({ turnId: 't2' }), CONFIG)
    expect(logs(first.effects)).toContain(`${HOLD} (turn end 2 since the nudge)`)
    expect(ofType(first.effects, 'nudge')).toEqual([{ type: 'nudge', text: nudgeText(420_000, 42), rearmedWindow: T0 }])
    expect(events(first.effects)).toContain('nudge-rearmed')
    const second = step(first.state, held({ turnId: 't3', rearmedWindow: T0 }), CONFIG)
    expect(logs(second.effects)).toContain(`${HOLD} (turn end 3 since the nudge)`)
    expect(ofType(second.effects, 'nudge')).toEqual([])
  })

  test('an activity-unknown end before the first held end does not spend the re-arm', () => {
    const unknown = step({ ...nudged(), backgroundTasks: null, sessionCrons: null }, turnEnd({ answer: DECISION }), CONFIG)
    expect(logs(unknown.effects).join('\n')).toContain('activity-unknown')
    const first = step({ ...unknown.state, backgroundTasks: 0, sessionCrons: 0 }, held(), CONFIG)
    expect(ofType(first.effects, 'nudge')).toHaveLength(1)
  })

  test('a re-arm delivered in an older window does not spend this one', () => {
    const s = step(nudged(), held({ rearmedWindow: T0 - 1 }), CONFIG)
    expect(ofType(s.effects, 'nudge')).toHaveLength(1)
  })

  test('a held end at the token ceiling runs at once with the decision as notes only', () => {
    const tokens = CONFIG.ceilingTokens
    const s = step(nudged(), held({ tokens }), CONFIG)
    expect(s.state.phase).toBe('BRIEFING')
    expect(logs(s.effects)).toContain(`decision-limit ${tokens} tokens >= ceiling ${CONFIG.ceilingTokens}; decision-unregistered: running anyway`)
    expect(ofType(s.effects, 'startAutoRun')).toEqual([{ type: 'startAutoRun', cycleId: `${OLD}#1`, decisionLimitReached: true }])
  })

  test('a waiting row, absent Track and a no-👉 answer take the ordinary run path', () => {
    for (const over of [{ waitingRows: 1 }, { waitingRows: 'absent' as const }, { answer: 'All done.' }]) {
      const s = step(nudged(), held(over), CONFIG)
      expect([JSON.stringify(over), s.state.phase]).toEqual([JSON.stringify(over), 'BRIEFING'])
      expect(ofType(s.effects, 'startAutoRun')).toEqual([{ type: 'startAutoRun', cycleId: `${OLD}#1` }])
    }
  })

  test('an unknown receipt holds under the same bound', () => {
    const s = step(nudged(), held({ waitingRows: 'unknown' }), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(logs(s.effects)).toContain(`${HOLD} (turn end 1 since the nudge)`)
  })

  test('an un-nudged 👉 turn end also holds, opening the nudge counter', () => {
    const s = step(idle(), held(), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(s.state.nudge?.turnEnds).toBe(1)
    expect(logs(s.effects)).toContain(`${HOLD} (turn end 1 since the nudge)`)
    expect(ofType(s.effects, 'nudge')).toHaveLength(1)
    expect(events(s.effects)).toContain('nudge-rearmed')
  })

  test('an empty answer with a same-session 👉 last response holds', () => {
    const state = { ...nudged(), lastResponse: { sessionId: OLD, turnId: 't0', text: DECISION } }
    const s = step(state, held({ answer: '' }), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(logs(s.effects)).toContain(`${HOLD} (turn end 1 since the nudge)`)
  })

  test('three held turn ends, then the fourth runs anyway with the decision as notes only; failedCycles unchanged', () => {
    const start = { ...nudged(), failedCycles: 1 }
    const three = run(start, [held(), held({ turnId: 't2' }), held({ turnId: 't3' })])
    expect(three.state.phase).toBe('IDLE')
    const fourth = step(three.state, held({ turnId: 't4' }), CONFIG)
    expect(fourth.state.phase).toBe('BRIEFING')
    expect(logs(fourth.effects)).toContain('decision-limit 3 turn ends since the nudge (limit 3); decision-unregistered: running anyway')
    expect(events(fourth.effects)).toContain('briefing')
    expect(ofType(fourth.effects, 'startAutoRun')).toEqual([{ type: 'startAutoRun', cycleId: `${OLD}#1`, decisionLimitReached: true }])
    expect(ofType(fourth.effects, 'pinNotice').some(p => p.text.includes(NOTES_ONLY))).toBe(true)
    expect(fourth.state.failedCycles).toBe(1)
  })

  test('the notes-only override drops only null-track_id items; a real id still needs coverage', () => {
    const real: PendingItem = { track_id: 'plan:7', subject: 'Review', note: 'Owner: User', unblock: 'Approve' }
    const loose: PendingItem = { track_id: null, subject: 'Pick go or no', note: NOTES_ONLY, unblock: 'Reply go' }
    expect(NOTES_ONLY).toBe('no Track row; notes only')
    expect(coveredItems([real, loose], true)).toEqual([real])
    expect(coveredItems([real, loose], false)).toEqual([real, loose])
  })
})

describe('W1 polish: needsDecisionCheck pins', () => {
  test('un-nudged: a draft or a background task means no Track read (the machine skips that end anyway)', () => {
    expect(needsDecisionCheck(idle(), held({ draft: 'half typed' }), CONFIG)).toBe(false)
    expect(needsDecisionCheck(idle({ backgroundTasks: 1 }), held(), CONFIG)).toBe(false)
  })
})

describe('W1 polish: needsDecisionCheck judges the state the machine judges', () => {
  // Reviewer probe Q1: IDLE, unclearedRuns at the cap, a typed prompt that lifted the cancel backoff, 600k last
  // tokens; a 👉 turn end at 450k is a compaction the hooks did not report, so the caps reset and the machine holds.
  const capped = () => step(idle({ unclearedRuns: UNCLEARED_RUN_CAP, lastTokens: 600_000, backoffTokens: 590_000, backoffKind: 'cancel' }),
    { type: 'typedPrompt', now: T0 + 500 }, CONFIG).state
  const pointing = (over: Partial<TurnEnd> = {}) => turnEnd({ tokens: 450_000, percent: 45, answer: DECISION, ...over })

  test('an inferred compaction that resets the caps: the Track read happens', () => {
    expect(capped().backoffTokens).toBeNull()
    expect(capped().unclearedRuns).toBe(UNCLEARED_RUN_CAP)
    const machine = step(capped(), pointing({ waitingRows: 0 }), CONFIG)
    expect(events(machine.effects)).toContain('compaction-inferred')
    expect(logs(machine.effects)).toContain(`${HOLD} (turn end 1 since the nudge)`)
    expect(needsDecisionCheck(capped(), pointing(), CONFIG)).toBe(true)
  })

  test('no inferred compaction: the cap still skips the end and no Track read happens', () => {
    expect(needsDecisionCheck({ ...capped(), lastTokens: 460_000 }, pointing(), CONFIG)).toBe(false)
  })
})
