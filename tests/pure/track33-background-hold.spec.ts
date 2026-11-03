import { DATA_ROUTE, DOMAIN_ROUTE, EXPLICIT_ROUTE } from '../fixtures/routing'

import { fixturePath } from '../fixtures/paths'

// TRACK-33: a lead that keeps starting background work must not starve the automatic handoff. The
// nudge asks it to start none, and past the ceiling every turn end held by background work pins why
// and queues one reminder for the next main tool result. The run still waits for a turn end with
// nothing running. Written red-first.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'
import { backgroundHoldNotice, backgroundReminderText, nudgeText, queueReminder } from '../../hooks/nudge'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const T0 = 1_000_000
const CONFIG: HandoffConfig = resolveConfig({}, {}).config

type TurnEnd = Extract<MachineEvent, { type: 'turnEnd' }>
type Measured = Extract<MachineEvent, { type: 'contextMeasured' }>

const BG_ASK = 'Start no new background work or subagents; let the running ones finish, then end the turn.'
const REMINDER = `Context handoff is waiting for background work to finish. ${BG_ASK}`
const noticeFor = (n: number) =>
  `context-handoff: ${n} background task(s) hold the handoff past the ceiling; it runs at the first turn end with none running. Start no new background work.`

const idle = (over: Partial<MachineState> = {}): MachineState => ({ ...initialState(OLD, T0, 'owner-a'), transcriptPath: fixturePath('t.jsonl'), ...over })
const measured = (over: Partial<Measured> = {}): Measured =>
  ({ type: 'contextMeasured', now: T0, sessionId: OLD, tokens: 412_345, percent: 41, isKillSwitchOn: false, openReviews: 0, ...over })
const turnEnd = (over: Partial<TurnEnd> = {}): TurnEnd =>
  ({ type: 'turnEnd', now: T0 + 1_000, sessionId: OLD, turnId: 't1', reason: 'answer', percent: 60, tokens: 600_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a', ...over })
const stopWith = (backgroundTasks: number | null, runningSubagents: number): MachineEvent =>
  ({ type: 'stop', backgroundTasks, runningSubagents, sessionCrons: 0, transcriptPath: fixturePath('t.jsonl') })
const events = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [e.event] : []))
const nonLog = (effects: Effect[]) => effects.filter(e => e.type !== 'log')
const nudged = (over: Partial<MachineState> = {}) => ({ ...step(idle(), measured(), CONFIG).state, ...over })

describe('the nudge asks to start no new background work', () => {
  test('the new sentence follows the existing ones', () => {
    const text = nudgeText(412_345, 41)
    expect(text.endsWith(` otherwise keep it in handoff notes. ${BG_ASK}`)).toBe(true)
    expect(nudgeText(undefined, 71).endsWith(` ${BG_ASK}`)).toBe(true)
  })
})

describe('the model-facing texts avoid the routing words', () => {
  // The same representative routing fixtures used for the seed and nudge.
  const PEER_VERBS = /(talk|discuss|consult|ask|route|coordinate|sync|work[\s]+with|use|instruct|tell|delegate|send)/i
  const WORDS = ['codex', 'claude', 'gemini', 'grok', 'cursor', 'amq', 'review', 'audit', 'data', 'report', 'user', 'task', 'paused']

  test('exact reminder wording', () => {
    expect(backgroundReminderText()).toBe(REMINDER)
  })

  for (const [name, text] of [['new sentence', BG_ASK], ['reminder', REMINDER]] as const) {
    test(`${name}: no peer verb, routing word, peer, brief word, user, task or paused`, () => {
      expect(text.match(PEER_VERBS)).toBeNull()
      expect([DATA_ROUTE.test(text), DOMAIN_ROUTE.test(text), EXPLICIT_ROUTE.test(text)]).toEqual([false, false, false])
      for (const word of WORDS) expect([word, text.toLowerCase().includes(word)]).toEqual([word, false])
      expect(text.includes('\n')).toBe(false)
    })
  }
})

describe('past the ceiling, a turn end held by background work pins why and queues the reminder', () => {
  test('one log, one notice naming the count, one reminder; no run and no re-arm marker', () => {
    const s = step(nudged({ backgroundTasks: 2, runningSubagents: 1 }), turnEnd(), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(events(s.effects)).toEqual(['ceiling-waiting-bg'])
    expect(nonLog(s.effects)).toEqual([
      { type: 'pinNotice', text: noticeFor(2) },
      { type: 'backgroundReminder', text: REMINDER },
    ])
  })

  test('two held turn ends in a row each pin once and queue once; the first with nothing running starts the run', () => {
    let state = nudged()
    const held: Effect[][] = []
    for (const turnId of ['t1', 't2']) {
      state = step(state, stopWith(1, 1), CONFIG).state
      const s = step(state, turnEnd({ turnId }), CONFIG)
      expect([turnId, s.state.phase, s.effects.some(e => e.type === 'startAutoRun')]).toEqual([turnId, 'IDLE', false])
      held.push(nonLog(s.effects))
      state = s.state
    }
    expect(held).toEqual([0, 1].map(() => [{ type: 'pinNotice', text: noticeFor(1) }, { type: 'backgroundReminder', text: REMINDER }]))
    state = step(state, stopWith(0, 0), CONFIG).state
    const clean = step(state, turnEnd({ turnId: 't3' }), CONFIG)
    expect(clean.state.phase).toBe('BRIEFING')
    expect(clean.effects.filter(e => e.type === 'pinNotice' || e.type === 'backgroundReminder')).toEqual([])
  })

  test('unknown activity holds too and its notice says so', () => {
    const s = step(nudged({ backgroundTasks: null }), turnEnd(), CONFIG)
    expect(s.state.phase).toBe('IDLE')
    expect(events(s.effects)).toEqual(['ceiling-waiting-bg'])
    expect(nonLog(s.effects)).toEqual([
      { type: 'pinNotice', text: backgroundHoldNotice(null) },
      { type: 'backgroundReminder', text: REMINDER },
    ])
    expect(backgroundHoldNotice(null)).toContain('background activity is unknown')
    expect(backgroundHoldNotice(3)).toBe(noticeFor(3))
  })

  test('below the ceiling, or held by the person, nothing new is pinned or queued', () => {
    const below = step(nudged({ backgroundTasks: 1 }), turnEnd({ tokens: 420_000 }), CONFIG)
    expect([events(below.effects), nonLog(below.effects)]).toEqual([['clean-wait'], []])
    const draft = step(nudged({ backgroundTasks: 0 }), turnEnd({ draft: 'x' }), CONFIG)
    expect([events(draft.effects), nonLog(draft.effects)]).toEqual([['ceiling-waiting-user'], []])
  })
})

describe('the reminder never clobbers a queued text', () => {
  test('queued only when nothing waits; a queued re-arm or reminder is kept as is', () => {
    expect(queueReminder(null, REMINDER)).toBe(REMINDER)
    const rearm = nudgeText(420_000, 42)
    expect(queueReminder(rearm, REMINDER)).toBe(rearm)
    expect(queueReminder(REMINDER, REMINDER)).toBe(REMINDER)
  })
})
