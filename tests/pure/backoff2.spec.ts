import { fixturePath } from '../fixtures/paths'

// Every pre-clear and clearing abort backs off; a failure backoff is lifted only by growth
// (a typed prompt lifts only a cancel backoff); after two failed cycles the session stops trying,
// with a pinned notice naming handoff.log. A compaction drop rebases the backoff; parseState
// coerces bad numbers. A bold-only "Instructions" line is a look-alike.
import { describe, expect, test } from 'bun:test'

import { composeBrief, parseTemplate, verifyBrief } from '../../hooks/brief'
import type { Template } from '../../hooks/brief'
import { resolveConfig } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'
import { parseState } from '../../hooks/state-file'
import { runToGrace } from './run-path'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const T0 = 1_000_000
const CONFIG = resolveConfig({}, {}).config
const GROW = CONFIG.minGrowthTokens

const idle = (): MachineState => ({ ...initialState(OLD, T0, 'owner-a'), transcriptPath: fixturePath(`tmp${fixturePath('t.jsonl')}`) })
let clock = T0
const turnEnd = (tokens: number): MachineEvent => {
  clock += 1_000
  return { type: 'turnEnd', now: clock, sessionId: OLD, turnId: `t${clock}`, reason: 'answer', percent: 75, tokens, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a' }
}
/** Brief writers started: the automatic run (startAutoRun) is the only one since W2b. */
const runsStarted = (effects: Effect[]) => effects.filter(e => e.type === 'startAutoRun').length
const run = (s: MachineState, events: MachineEvent[]) => events.reduce<{ state: MachineState; effects: Effect[] }>(
  (acc, e) => {
    const r = step(acc.state, e, CONFIG)
    return { state: r.state, effects: [...acc.effects, ...r.effects] }
  }, { state: s, effects: [] })

function toGrace(s: MachineState): MachineState {
  return runToGrace(s, CONFIG, clock, fixturePath('b.md'), { project: 'p', verified: 'p' })
}
function toClearing(s: MachineState): MachineState {
  const g = toGrace(s)
  return step(g, { type: 'tick', now: g.deadline as number, isKillSwitchOn: false }, CONFIG).state
}

const refusedClear = (s: MachineState) => step(toClearing(s), { type: 'clearResult', cycleId: s.cycleId as string, now: clock + 9, failure: 'refused' }, CONFIG)
const clearTimeout = (s: MachineState) => { const c = toClearing(s); return step(c, { type: 'tick', now: (c.deadline as number) + 1, isKillSwitchOn: false }, CONFIG) }
/** W2b: the fork failure's place is a failed automatic run (the same failure accounting). */
const runFailure = (s: MachineState) => step(s, { type: 'autoRunFailed', cycleId: s.cycleId as string, now: clock + 1, failure: 'boom' }, CONFIG)

describe('[medium a] a failed clear backs off', () => {
  test.each([['refused clear', refusedClear], ['clear timeout', clearTimeout]])('after a %s, the next turn ends start no run', (_l, fail) => {
    clock = T0
    const briefing = step(idle(), turnEnd(750_000), CONFIG).state
    let s = fail(briefing).state
    expect(s.phase).toBe('IDLE')
    let n = 0
    for (const t of [760_000, 770_000, 780_000]) { const r = step(s, turnEnd(t), CONFIG); n += runsStarted(r.effects); s = r.state }
    expect(n).toBe(0)
  })
})

describe('[medium b] a typed prompt lifts only a cancel backoff', () => {
  test('after a failed run, a typed prompt does not let the next turn end start one', () => {
    clock = T0
    let s = runFailure(step(idle(), turnEnd(750_000), CONFIG).state).state
    s = step(s, { type: 'typedPrompt', now: clock + 5 }, CONFIG).state
    expect(runsStarted(step(s, turnEnd(760_000), CONFIG).effects)).toBe(0)
  })

  // W2c: in BRIEFING a Stop block now keeps the skill run (auto-run.spec "a Stop-gate block keeps the
  // run"), so the stop-blocked cancel is taken in GRACE, where it still ends the cycle as a failure.
  test('a stop-blocked cancel is a failure: a typed prompt does not lift it', () => {
    clock = T0
    let s = toGrace(step(idle(), turnEnd(750_000), CONFIG).state)
    expect(s.phase).toBe('GRACE')
    s = step(s, { type: 'cancel', now: clock + 1, reason: 'stop-blocked' }, CONFIG).state
    expect([s.phase, s.backoffKind, s.failedCycles]).toEqual(['IDLE', 'failure', 1])
    s = step(s, { type: 'typedPrompt', now: clock + 2 }, CONFIG).state
    expect(runsStarted(step(s, turnEnd(760_000), CONFIG).effects)).toBe(0)
  })

  // The Cancel button now means "not now" (growth only, backoff3.spec.ts); a plain cancel is still lifted.
  test('a plain cancel backoff (another turn) is lifted by a typed prompt', () => {
    clock = T0
    let s = step(idle(), turnEnd(750_000), CONFIG).state
    s = step(s, { type: 'cancel', now: clock + 1, reason: 'other-turn' }, CONFIG).state
    s = step(s, { type: 'typedPrompt', now: clock + 2 }, CONFIG).state
    expect(runsStarted(step(s, turnEnd(760_000), CONFIG).effects)).toBe(1)
  })
})

describe('[medium c] after two failed cycles the session stops trying', () => {
  test('a third cycle never starts, even with growth, and the second failure pins a notice naming handoff.log', () => {
    clock = T0
    let s = runFailure(step(idle(), turnEnd(700_000), CONFIG).state).state
    const second = runFailure(step(s, turnEnd(700_000 + GROW), CONFIG).state)
    s = second.state
    expect(second.effects.some(e => e.type === 'pinNotice' && /handoff\.log/.test((e as { text: string }).text))).toBe(true)
    expect(runsStarted(step(s, turnEnd(700_000 + 3 * GROW), CONFIG).effects)).toBe(0)
    s = step(s, { type: 'typedPrompt', now: clock + 1 }, CONFIG).state
    expect(runsStarted(step(s, turnEnd(700_000 + 4 * GROW), CONFIG).effects)).toBe(0)
  })
})

describe('[low] a compaction drop rebases the backoff', () => {
  // W2c: the default trigger is now 400000 tokens, so 150k would be below it; this test keeps the
  // percent trigger it was written for (turn ends report 75%) and still measures growth from 50k.
  test('after a failure at 750k and a compaction to 50k, growth is measured from 50k', () => {
    const PERCENT = { ...CONFIG, thresholdTokens: null, thresholdPercent: 70 }
    clock = T0
    let s = step(step(idle(), turnEnd(750_000), PERCENT).state, { type: 'autoRunFailed', cycleId: `${OLD}#1`, now: clock + 1, failure: 'boom' }, PERCENT).state
    expect([s.phase, s.backoffTokens]).toEqual(['IDLE', 750_000])
    s = step(s, turnEnd(50_000), PERCENT).state
    expect(s.backoffTokens).toBe(50_000)
    expect(runsStarted(step(s, turnEnd(50_000 + GROW - 1), PERCENT).effects)).toBe(0)
    expect(runsStarted(step(s, turnEnd(50_000 + GROW), PERCENT).effects)).toBe(1)
  })
})

describe('[low] parseState coerces bad numbers', () => {
  test('a non-number backoffTokens or cycleStartTokens reads as null', () => {
    const text = JSON.stringify({ ...initialState(OLD, T0, 'o'), backoffTokens: 'abc', cycleStartTokens: 'x' })
    const parsed = parseState(text) as MachineState
    expect(parsed.backoffTokens).toBeNull()
    expect(parsed.cycleStartTokens).toBeNull()
  })
})

const TEMPLATE_TEXT = [
  '<!-- header -->', 'session: <id>', 'previous: <id>', 'transcript: <path>', 'created: <time>', '<!-- /header -->', '',
  '## 1. Active goal and role', '*g*', '## 2. User decisions and constraints, verbatim, dated', '*g*',
  '## 3. Pending, owned by the user', '*g*', '## 4. In flight', '*g*', '## 5. Identifiers the next context must type', '*g*',
  '## 6. Last outgoing instruction', '*g*', '## 7. Do not redo', '*g*', '## 8. Last request and status', '*g*',
  '## 9. Dead ends', '*g*', '## 10. Assumptions to verify', '*g*',
].join('\n')
const template = parseTemplate(TEMPLATE_TEXT) as Template
const HEADER = { session: '11111111-aaaa-4bbb-8ccc-000000000001', previous: 'none', transcript: fixturePath('t.jsonl'), created: '2026-10-05T10:00:00+03:00', tokens: 700_000 }
const SECTIONS = (six: string) => [
  '## 1. Active goal and role', 'g', '## 2. User decisions and constraints, verbatim, dated', 'q',
  '## 3. Pending, owned by the user', 'none', '## 4. In flight', 'none', '## 5. Identifiers the next context must type', 'x',
  '## 6. Last outgoing instruction', six, '## 7. Do not redo', 'none', '## 8. Last request and status', 'r', 'Status: partial',
  '## 9. Dead ends', 'none', '## 10. Assumptions to verify', 'a',
].join('\n')
const FACTS = ['## Facts from the transcript', `Source: ${fixturePath('t.jsonl')}`, '### Last user request', '- fix'].join('\n')

describe('[option] a bold-only "Instructions" line is a look-alike', () => {
  test.each(['**Instructions**', '**INSTRUCTIONS:**', '**New instruction**'])('refused: %p', six => {
    expect('failure' in verifyBrief(composeBrief(template, HEADER, SECTIONS(six), FACTS) as string, template)).toBe(true)
  })
})
