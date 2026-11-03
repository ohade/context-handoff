// A prompt typed while the previous turn is finishing keeps its composer origin.
// A crossed prompt binds only the turn that carries its text.
import { describe, expect, test } from 'bun:test'

import { gateHandoffNow } from '../../hooks/handoff-now'
import type { TurnOrigin } from '../../hooks/machine-types'
import { TurnTracker } from '../../hooks/turns'

const LIVE_TURN_TEXT = '<command-message>compact-crafter</command-message>\n<command-name>/compact-crafter</command-name>'
const DOORBELL = ': AMQ doorbell run amq drain --include-body then act on it'
const TASK_NOTE = '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>'
const commandTurn = (name: string, args: string) =>
  `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`
const unbound = (turnId: string, turnText: string) => ({ turnId, origin: 'other', promptText: '', turnText, isPrompted: false })

/** A prompt submitted while idle that then crosses the end of the turn that was still finishing. */
function crossed(promptText: string, origin: TurnOrigin = 'composer'): TurnTracker {
  const t = new TurnTracker()
  t.onTurnStart('t0', 'earlier work')
  t.onPromptSubmit(origin, promptText, undefined)
  t.onTurnComplete('t0')
  return t
}

describe('typed prompt across a turn end', () => {
  test('live sequence: /compact-crafter typed as t0 finishes starts t1 as composer and opens the handoff_now gate', () => {
    const t = crossed('/compact-crafter')
    expect(t.onTurnStart('t1', LIVE_TURN_TEXT)).toEqual({
      turnId: 't1', origin: 'composer', promptText: '/compact-crafter', turnText: LIVE_TURN_TEXT, isPrompted: true,
    })
    expect(gateHandoffNow(t.current, undefined, false)).toEqual({ queue: 'manual' })
  })

  test('plain text: a crossed prompt binds the turn whose text equals it', () => {
    const t = crossed('please compact')
    expect(t.onTurnStart('t1', '  please compact\n')).toEqual({
      turnId: 't1', origin: 'composer', promptText: 'please compact', turnText: '  please compact\n', isPrompted: true,
    })
  })

  test('a slash command with the same args binds', () => {
    const t = crossed('/compact-crafter now')
    const text = commandTurn('compact-crafter', ' now ')
    expect(t.onTurnStart('t1', text)).toEqual({ turnId: 't1', origin: 'composer', promptText: '/compact-crafter now', turnText: text, isPrompted: true })
  })
})

describe('a crossed prompt never lends its origin to an unrelated turn', () => {
  test('blocked prompt then a continuation (empty text) is byte-identical to today', () => {
    const t = crossed('/compact-crafter')
    expect(t.onTurnStart('t1', '')).toEqual(unbound('t1', ''))
    expect(gateHandoffNow(t.current, undefined, false)).not.toEqual({ queue: 'manual' })
  })

  test('blocked prompt then an AMQ doorbell turn, then a task-notification turn', () => {
    const t = crossed('/compact-crafter')
    expect(t.onTurnStart('t1', DOORBELL)).toEqual(unbound('t1', DOORBELL))
    t.onTurnComplete('t1')
    expect(t.onTurnStart('t2', TASK_NOTE)).toEqual(unbound('t2', TASK_NOTE))
  })

  test('blocked prompt then a task-notification turn directly', () => {
    const t = crossed('/compact-crafter')
    expect(t.onTurnStart('t1', TASK_NOTE)).toEqual(unbound('t1', TASK_NOTE))
  })

  test('a slash command with different args does not bind', () => {
    const t = crossed('/compact-crafter now')
    const text = commandTurn('compact-crafter', 'later')
    expect(t.onTurnStart('t1', text)).toEqual(unbound('t1', text))
  })

  test('an argless slash command does not bind a turn of the same command that carries args (the automatic run)', () => {
    const t = crossed('/compact-crafter')
    const text = commandTurn('compact-crafter', 'automatic-run cycle=c1 session=s1')
    expect(t.onTurnStart('t1', text)).toEqual(unbound('t1', text))
  })

  test('two turn ends before a turn start discard the crossed prompt', () => {
    const t = crossed('/compact-crafter')
    t.onTurnComplete('t0b')
    expect(t.onTurnStart('t1', LIVE_TURN_TEXT)).toEqual(unbound('t1', LIVE_TURN_TEXT))
  })

  test('a crossed /recall foo does not bind a /compact-crafter turn', () => {
    const t = crossed('/recall foo')
    expect(t.onTurnStart('t1', LIVE_TURN_TEXT)).toEqual(unbound('t1', LIVE_TURN_TEXT))
  })

  test('a crossed prompt is discarded once a non-matching turn starts', () => {
    const t = crossed('/compact-crafter')
    t.onTurnStart('t1', DOORBELL)
    t.onTurnComplete('t1')
    expect(t.onTurnStart('t2', LIVE_TURN_TEXT)).toEqual(unbound('t2', LIVE_TURN_TEXT))
  })
})

describe('a crossed slash prompt binds only a turn made of its own command markup (amendment 1)', () => {
  test('F1: a task-notification quoting the command markup does not bind', () => {
    const t = crossed('/compact-crafter')
    const text = '<task-notification>\n<result>ran <command-name>/compact-crafter</command-name></result>\n</task-notification>'
    expect(t.onTurnStart('t1', text)).toEqual(unbound('t1', text))
    expect(gateHandoffNow(t.current, undefined, false)).not.toEqual({ queue: 'manual' })
  })

  test('F1: leading prose around otherwise valid command markup does not bind', () => {
    const t = crossed('/compact-crafter')
    const text = `see this:\n${LIVE_TURN_TEXT}`
    expect(t.onTurnStart('t1', text)).toEqual(unbound('t1', text))
  })

  test('F1: trailing prose after otherwise valid command markup does not bind', () => {
    const t = crossed('/compact-crafter')
    const text = `${LIVE_TURN_TEXT}\nand then do something else`
    expect(t.onTurnStart('t1', text)).toEqual(unbound('t1', text))
  })

  test('F1: two command-name elements do not bind', () => {
    const t = crossed('/compact-crafter')
    const text = `${LIVE_TURN_TEXT}\n<command-name>/compact-crafter</command-name>`
    expect(t.onTurnStart('t1', text)).toEqual(unbound('t1', text))
  })

  test('F3: an argless prompt does not bind a turn whose args contain "<"', () => {
    const t = crossed('/compact-crafter')
    const text = commandTurn('compact-crafter', 'a<b')
    expect(t.onTurnStart('t1', text)).toEqual(unbound('t1', text))
  })

  test('F3: a prompt whose args contain "<" binds a turn with those args', () => {
    const t = crossed('/compact-crafter a<b')
    const text = commandTurn('compact-crafter', 'a<b')
    expect(t.onTurnStart('t1', text)).toEqual({ turnId: 't1', origin: 'composer', promptText: '/compact-crafter a<b', turnText: text, isPrompted: true })
  })

  test('an argless prompt binds a turn whose args element is empty', () => {
    const t = crossed('/compact-crafter')
    const text = commandTurn('compact-crafter', '  ')
    expect(t.onTurnStart('t1', text)).toMatchObject({ origin: 'composer', promptText: '/compact-crafter', isPrompted: true })
  })

  test('F4a: a crossed prompt is discarded at a non-matching turn start', () => {
    const t = crossed('/compact-crafter')
    expect(t.onTurnStart('t1', DOORBELL)).toEqual(unbound('t1', DOORBELL))
    expect(t.onTurnStart('t2', LIVE_TURN_TEXT)).toEqual(unbound('t2', LIVE_TURN_TEXT))
  })

  test('F4b: a crossed /compact does not bind a /compact-crafter turn', () => {
    const t = crossed('/compact')
    expect(t.onTurnStart('t1', LIVE_TURN_TEXT)).toEqual(unbound('t1', LIVE_TURN_TEXT))
  })

  test('F4c: a crossed whitespace-only prompt does not bind an empty turn', () => {
    const t = crossed('   ')
    expect(t.onTurnStart('t1', '')).toEqual(unbound('t1', ''))
  })

  test('B1: an argless prompt does not bind a turn with a second args element', () => {
    const t = crossed('/compact-crafter')
    const text = '<command-name>/compact-crafter</command-name><command-args>automatic-run cycle=C session=S</command-args><command-args></command-args>'
    expect(t.onTurnStart('t1', text)).toEqual(unbound('t1', text))
  })

  test('B1: a prompt does not bind a turn whose message element holds markup', () => {
    const t = crossed('/compact-crafter')
    const text = '<command-message><task-notification>x</task-notification></command-message>\n<command-name>/compact-crafter</command-name>'
    expect(t.onTurnStart('t1', text)).toEqual(unbound('t1', text))
  })
})

describe('crossing applies to every origin (amendment 1, A4)', () => {
  test('a crossed AMQ doorbell prompt binds its own doorbell turn with its origin', () => {
    const t = crossed(DOORBELL)
    expect(t.onTurnStart('t1', DOORBELL)).toEqual({ turnId: 't1', origin: 'composer', promptText: DOORBELL, turnText: DOORBELL, isPrompted: true })
  })

  test('a crossed automatic-run prompt binds its own run turn as own-skill', () => {
    const prompt = '/compact-crafter automatic-run cycle=C session=S'
    const t = crossed(prompt, 'own-skill')
    const text = commandTurn('compact-crafter', 'automatic-run cycle=C session=S')
    expect(t.onTurnStart('t1', text)).toEqual({ turnId: 't1', origin: 'own-skill', promptText: prompt, turnText: text, isPrompted: true })
  })
})

describe('unchanged paths', () => {
  test('a prompt that has not crossed a turn end binds with no text check', () => {
    const t = new TurnTracker()
    t.onPromptSubmit('composer', 'please compact', undefined)
    expect(t.onTurnStart('t1', 'different text')).toEqual({
      turnId: 't1', origin: 'composer', promptText: 'please compact', turnText: 'different text', isPrompted: true,
    })
  })

  test('a new idle submit replaces a crossed prompt and binds as today', () => {
    const t = crossed('/compact-crafter')
    t.onPromptSubmit('own-seed', 'seed text', undefined)
    expect(t.onTurnStart('t1', 'other text')).toEqual({ turnId: 't1', origin: 'own-seed', promptText: 'seed text', turnText: 'other text', isPrompted: true })
  })

  test('a submit typed over a running turn (turnId set) leaves a crossed prompt in place', () => {
    const t = crossed('/compact-crafter')
    t.onPromptSubmit('composer', 'steer', 't0')
    expect(t.onTurnStart('t1', LIVE_TURN_TEXT)).toMatchObject({ origin: 'composer', promptText: '/compact-crafter', isPrompted: true })
  })

  test('a turn end clears current only for its own turn', () => {
    const t = new TurnTracker()
    t.onTurnStart('t1', 'x')
    t.onTurnComplete('t9')
    expect(t.current?.turnId).toBe('t1')
    t.onTurnComplete('t1')
    expect(t.current).toBeNull()
  })
})
