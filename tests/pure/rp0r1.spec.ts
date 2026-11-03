import { fixturePath } from '../fixtures/paths'

import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import { extractorArgv, normalizePrompt } from '../../hooks/handoff-now'
import { initialState, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'

const CONFIG = resolveConfig({}, {}).config
const A = '11111111-aaaa-4bbb-8ccc-000000000001'
const B = '22222222-aaaa-4bbb-8ccc-000000000002'
const C = '33333333-aaaa-4bbb-8ccc-000000000003'

function run(s: MachineState, events: MachineEvent[]) {
  const fx: Effect[] = []
  for (const e of events) {
    const r = step(s, e, CONFIG)
    s = r.state
    fx.push(...r.effects)
  }
  return { state: s, effects: fx }
}
const fills = (fx: Effect[]) => fx.filter(f => f.type === 'fillSeed')
const end = (sid: string, turnId: string, now: number): MachineEvent =>
  ({ type: 'turnEnd', now, sessionId: sid, turnId, reason: 'answer', percent: 10, tokens: 1, draft: '', isKillSwitchOn: false, answer: '' }) as MachineEvent

/** A manual handoff in `sid` through to CLEARING. */
function toClearing(s: MachineState, sid: string, brief: string, turnId: string, now: number): MachineState {
  const g = run(s, [{ type: 'manualBrief', now, path: brief, turnId, markers: null } as MachineEvent, end(sid, turnId, now + 1)]).state
  expect(g.phase).toBe('GRACE')
  return step(g, { type: 'tick', now: g.deadline as number, isKillSwitchOn: false }, CONFIG).state
}

describe('[medium] no stale seed after an unrelated /clear', () => {
  const base = () => ({ ...initialState(A, 0, 'o'), transcriptPath: fixturePath('t.jsonl') })

  test('M2-M4: refused clear, then a successful handoff into B, then the user\'s /clear in B fills nothing', () => {
    const c1 = toClearing(base(), A, fixturePath('b1.md'), 't1', 1_000)
    const refused = step(c1, { type: 'clearResult', cycleId: c1.cycleId as string, now: c1.enteredAt + 1, failure: 'no' }, CONFIG).state
    expect(refused.lastClearTimeout?.briefPath).toBe(fixturePath('b1.md'))
    const c2 = toClearing(refused, A, fixturePath('b2.md'), 't2', refused.enteredAt + 10)
    const inB = run(c2, [
      { type: 'sessionStart', now: c2.enteredAt + 5, sessionId: B, source: 'clear' },
      { type: 'carryDone', cycleId: c2.cycleId as string, now: c2.enteredAt + 6 },
      { type: 'seedDelivered', cycleId: c2.cycleId as string, now: c2.enteredAt + 7 },
    ]).state
    expect(inB.sessionId).toBe(B)
    expect(inB.lastClearTimeout).toBeNull()
    const userClear = step(inB, { type: 'sessionStart', now: inB.enteredAt + 60_000, sessionId: C, source: 'clear' }, CONFIG)
    expect(fills(userClear.effects)).toEqual([])
  })

  test('a new cycle start resets the record', () => {
    const c1 = toClearing(base(), A, fixturePath('b1.md'), 't1', 1_000)
    const refused = step(c1, { type: 'clearResult', cycleId: c1.cycleId as string, now: c1.enteredAt + 1, failure: 'no' }, CONFIG).state
    const g = run(refused, [{ type: 'manualBrief', now: refused.enteredAt + 1, path: fixturePath('b2.md'), turnId: 't2', markers: null } as MachineEvent, end(A, 't2', refused.enteredAt + 2)]).state
    expect(g.phase).toBe('GRACE')
    expect(g.lastClearTimeout).toBeNull()
  })

  test('the record names the session whose clear failed, and fills only when that session is cleared', () => {
    const c1 = toClearing(base(), A, fixturePath('b1.md'), 't1', 1_000)
    const refused = step(c1, { type: 'clearResult', cycleId: c1.cycleId as string, now: c1.enteredAt + 1, failure: 'no' }, CONFIG).state
    expect(refused.lastClearTimeout?.sessionId).toBe(A)
    const elsewhere = { ...refused, sessionId: B }
    expect(fills(step(elsewhere, { type: 'sessionStart', now: refused.enteredAt + 10, sessionId: C, source: 'clear' }, CONFIG).effects)).toEqual([])
    expect(fills(step(refused, { type: 'sessionStart', now: refused.enteredAt + 10, sessionId: C, source: 'clear' }, CONFIG).effects)).toHaveLength(1)
  })
})

describe('[low] the handoff anchor is excluded however the prompt was typed', () => {
  test('the gating prompt is trimmed and its whitespace collapsed', () => {
    expect(normalizePrompt('  /compact-crafter   keep\n\n the plan \n')).toBe('/compact-crafter keep the plan')
  })

  test('the extractor argv excludes the normalised prompt and any /compact-crafter prompt', () => {
    expect(extractorArgv(fixturePath('x/facts.py'), fixturePath('t.jsonl'), '/compact-crafter\n')).toEqual([
      'python3', fixturePath('x/facts.py'), fixturePath('t.jsonl'), '--markdown', '--user-requests', '--exclude-prompt', '/compact-crafter', '--exclude-prefix', '/context-handoff:compact-crafter', '--exclude-prefix', '/compact-crafter',
    ])
    expect(extractorArgv(fixturePath('x/facts.py'), fixturePath('t.jsonl'), null)).toEqual(['python3', fixturePath('x/facts.py'), fixturePath('t.jsonl'), '--markdown', '--user-requests'])
  })
})

describe('[low] a session change drops a queued manual brief', () => {
  test('a /clear before the gating turn ends clears manualPending', () => {
    const s = step({ ...initialState(A, 0, 'o'), transcriptPath: fixturePath('t.jsonl') }, { type: 'manualBrief', now: 1, path: fixturePath('b.md'), turnId: 't1', markers: null } as MachineEvent, CONFIG).state
    expect(s.manualPending).not.toBeNull()
    expect(step(s, { type: 'sessionStart', now: 2, sessionId: B, source: 'clear' }, CONFIG).state.manualPending).toBeNull()
  })
})
