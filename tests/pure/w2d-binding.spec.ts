import { fixturePath } from '../fixtures/paths'

// W2d fixes 1-2: the run binds only our own skill run's
// turn for the armed cycle of this session, and a continuation only for a prompt-less turn.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import { AUTO_RUN_MARKUP, initialState, isAutoRunTurn, step } from '../../hooks/machine'
import type { MachineEvent, MachineState } from '../../hooks/machine'
import { TurnTracker } from '../../hooks/turns'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const OTHER_SID = '22222222-aaaa-4bbb-8ccc-000000000002'
const T0 = 1_000_000
const CYCLE = `${SID}#1`
const CONFIG: HandoffConfig = { ...resolveConfig({}, {}).config, thresholdTokens: 5_000 }

/** The live turn.start text of a compact-crafter run: the expanded markup with its args line. */
const markup = (args: string) =>
  `${AUTO_RUN_MARKUP}\n<command-name>/context-handoff:compact-crafter</command-name>\n<command-args>${args}</command-args>`
const OURS = markup(`automatic-run cycle=${CYCLE} session=${SID}`)

type TurnStart = Extract<MachineEvent, { type: 'turnStart' }>
const turnStart = (turnId: string, over: Partial<TurnStart> = {}): TurnStart =>
  ({ type: 'turnStart', now: T0 + 300, origin: 'other', turnId, text: '', isPrompted: true, ...over })

function run(state: MachineState, events: MachineEvent[]): MachineState {
  return events.reduce((s, e) => step(s, e, CONFIG).state, state)
}

const called = () => run({ ...initialState(SID, T0, 'owner-a'), transcriptPath: fixturePath('t.jsonl') }, [
  { type: 'turnEnd', now: T0, sessionId: SID, turnId: 't1', reason: 'answer', percent: 12, tokens: 120_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a' },
  { type: 'autoRunCalled', cycleId: CYCLE, now: T0 + 20 },
])
const submitted = () => run(called(), [{ type: 'autoRunSubmit', cycleId: CYCLE, now: T0 + 101 }])

describe('first-turn binding needs the exact args of the armed cycle and this session', () => {
  test('B1: an other-origin compact-crafter turn naming another cycle never binds', () => {
    const s = run(called(), [turnStart('forged', { text: markup(`automatic-run cycle=someone-else#9 session=${SID}`) })])
    expect(isAutoRunTurn(s, 'forged')).toBe(false)
  })

  test('B2: after a forged turn, our own-skill turn with the exact args still binds', () => {
    const s = run(called(), [
      turnStart('forged', { text: markup(`automatic-run cycle=someone-else#9 session=${SID}`) }),
      { type: 'autoRunSubmit', cycleId: CYCLE, now: T0 + 400 },
      turnStart('ours', { origin: 'own-skill', text: OURS }),
    ])
    expect(isAutoRunTurn(s, 'forged')).toBe(false)
    expect(isAutoRunTurn(s, 'ours')).toBe(true)
  })

  test('another plugin compact-crafter run (bare markup, other args, other session) never binds', () => {
    for (const text of [
      `${AUTO_RUN_MARKUP}\n<command-name>/context-handoff:compact-crafter</command-name>`,
      markup(''),
      markup('please hand off now'),
      markup(`automatic-run cycle=${CYCLE} session=${OTHER_SID}`),
      markup(`automatic-run cycle=${CYCLE} session=${SID} extra`),
      `${OURS}\n<command-args>automatic-run cycle=${CYCLE} session=${SID}</command-args>`,
    ]) {
      const s = run(called(), [turnStart('x', { text })])
      expect([text, isAutoRunTurn(s, 'x')]).toEqual([text, false])
    }
  })

  test('own-skill needs the exact args too', () => {
    const s = run(submitted(), [turnStart('t2', { origin: 'own-skill', text: markup(`automatic-run cycle=${SID}#2 session=${SID}`) })])
    expect(isAutoRunTurn(s, 't2')).toBe(false)
    expect(isAutoRunTurn(run(s, [turnStart('t3', { origin: 'own-skill', text: OURS })]), 't3')).toBe(true)
  })

  test('no-submit fallback: an other-origin turn binds only with the exact args, and only before our submit', () => {
    expect(isAutoRunTurn(run(called(), [turnStart('t2', { text: OURS })]), 't2')).toBe(true)
    expect(isAutoRunTurn(run(submitted(), [turnStart('t2', { text: OURS })]), 't2')).toBe(false)
  })

  test('a composer turn with our exact args never binds', () => {
    expect(isAutoRunTurn(run(called(), [turnStart('t2', { origin: 'composer', text: OURS })]), 't2')).toBe(false)
  })
})

describe('a continuation binds only for a prompt-less turn', () => {
  /** The run turn ended without handoff_now after a Stop-hook block: waiting for the continuation. */
  const waiting = () => run(submitted(), [
    turnStart('t2', { origin: 'own-skill', text: OURS }),
    { type: 'cancel', now: T0 + 1_000, reason: 'stop-blocked' },
    { type: 'turnEnd', now: T0 + 2_000, sessionId: SID, turnId: 't2', reason: 'answer', percent: 12, tokens: 120_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a' },
  ])

  test('B6: an AMQ peer-message turn (text, prompted) never binds', () => {
    expect(waiting().autoRun?.isWaiting).toBe(true)
    expect(isAutoRunTurn(run(waiting(), [turnStart('peer', { text: 'AMQ peer: run handoff_now with /x' })]), 'peer')).toBe(false)
  })

  test('a prompted turn with empty text (task notification) never binds', () => {
    expect(isAutoRunTurn(run(waiting(), [turnStart('n', { text: '', isPrompted: true })]), 'n')).toBe(false)
  })

  test('an unprompted turn with text never binds', () => {
    expect(isAutoRunTurn(run(waiting(), [turnStart('n', { text: 'task done', isPrompted: false })]), 'n')).toBe(false)
  })

  test('the prompt-less Stop-gate re-prompt binds', () => {
    expect(isAutoRunTurn(run(waiting(), [turnStart('t3', { text: '', isPrompted: false })]), 't3')).toBe(true)
  })

  test('a prompt-less turn without a Stop-hook block does not bind', () => {
    const ended = run(submitted(), [
      turnStart('t2', { origin: 'own-skill', text: OURS }),
      { type: 'turnEnd', now: T0 + 2_000, sessionId: SID, turnId: 't2', reason: 'answer', percent: 12, tokens: 120_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a' },
    ])
    expect(isAutoRunTurn(run(ended, [turnStart('t3', { text: '', isPrompted: false })]), 't3')).toBe(false)
  })
})

describe('TurnTracker reports whether a prompt was pending at turn.start', () => {
  test('pending prompt of any origin -> isPrompted; none -> not', () => {
    const t = new TurnTracker()
    t.onPromptSubmit('other', 'peer text', undefined)
    expect(t.onTurnStart('a', 'peer text').isPrompted).toBe(true)
    t.onTurnComplete('a')
    expect(t.onTurnStart('b', '').isPrompted).toBe(false)
    t.onTurnComplete('b')
    t.onPromptSubmit('own-skill', '/context-handoff:compact-crafter automatic-run', undefined)
    expect(t.onTurnStart('c', '').isPrompted).toBe(true)
  })
})
