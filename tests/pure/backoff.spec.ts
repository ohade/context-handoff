import { fixturePath } from '../fixtures/paths'

// 1. After any pre-clear cycle ends without a clear (brief rejected, fork failure, timeout, cancel),
//    no new full-context fork starts until the context grows by minGrowthTokens or the user types.
// 2. A bold label in a model-written section ("**Instruction sent to Codex:**") is not a look-alike
//    heading; only the look-alike phrases are.
import { describe, expect, test } from 'bun:test'

import { composeBrief, parseTemplate, verifyBrief } from '../../hooks/brief'
import type { Template } from '../../hooks/brief'
import { resolveConfig } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'

const OLD = '11111111-aaaa-bbbb-cccc-000000000001'
const T0 = 1_000_000
const CONFIG = resolveConfig({}, {}).config

const idle = (): MachineState => ({ ...initialState(OLD, T0, 'owner-a'), transcriptPath: fixturePath(`tmp${fixturePath('t.jsonl')}`) })
const turnEnd = (tokens: number, now: number, turnId = `t${now}`): MachineEvent => ({
  type: 'turnEnd', now, sessionId: OLD, turnId, reason: 'answer', percent: 75, tokens,
  draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a',
})
const logs = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [`${e.event} ${e.detail}`] : []))

/** Start a cycle at `tokens`, then end it with `fail`; returns the IDLE state after the failure. */
function failedCycle(tokens: number, fail: (s: MachineState) => MachineEvent): MachineState {
  const briefing = step(idle(), turnEnd(tokens, T0, 'trigger'), CONFIG).state
  expect(briefing.phase).toBe('BRIEFING')
  const after = step(briefing, fail(briefing), CONFIG).state
  expect(after.phase).toBe('IDLE')
  return after
}

/** W2c: the fork failure's place is a failed automatic run (the same failure accounting). */
const runFailed = (s: MachineState): MachineEvent => ({ type: 'autoRunFailed', cycleId: s.cycleId as string, now: T0 + 5, failure: 'run error' })
const timedOut = (s: MachineState): MachineEvent => ({ type: 'tick', now: (s.deadline as number) + 1, isKillSwitchOn: false })

describe('[low] backoff after a failed cycle bounds the cost of every failure path', () => {
  test.each([
    ['failed automatic run', runFailed],
    ['automatic run timeout', timedOut],
  ])('after a %s, two consecutive turn ends above the threshold start no second run', (_label, fail) => {
    let s = failedCycle(750_000, fail)
    for (const [i, tokens] of [[1, 760_000], [2, 790_000]] as const) {
      const r = step(s, turnEnd(tokens, T0 + 1_000 * i), CONFIG)
      expect(r.state.phase).toBe('IDLE')
      expect(r.effects.some(e => e.type === 'startAutoRun')).toBe(false)
      expect(logs(r.effects).join('\n')).toMatch(/guard-skip backoff/)
      s = r.state
    }
  })

  test('the backoff lifts once the context grew by minGrowthTokens since the failed cycle started', () => {
    const s = failedCycle(750_000, runFailed)
    const r = step(s, turnEnd(750_000 + CONFIG.minGrowthTokens, T0 + 9_000), CONFIG)
    expect(r.state.phase).toBe('BRIEFING')
  })

  // A typed prompt lifts only a plain cancel backoff: a failure (backoff2.spec.ts) and the Cancel
  // button's "not now" (backoff3.spec.ts) wait for growth, so this case starts from another turn's cancel.
  test('a typed prompt lifts a cancel backoff at once', () => {
    let s = failedCycle(750_000, () => ({ type: 'cancel', now: T0 + 5, reason: 'other-turn' }))
    s = step(s, { type: 'typedPrompt', now: T0 + 6_000 }, CONFIG).state
    const r = step(s, turnEnd(760_000, T0 + 7_000), CONFIG)
    expect(r.state.phase).toBe('BRIEFING')
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
const HEADER = {
  session: '11111111-aaaa-4bbb-8ccc-000000000001', previous: 'none', transcript: fixturePath('t.jsonl'),
  created: '2026-10-05T10:00:00+03:00', tokens: 700_000,
}
const SECTIONS = (six: string) => [
  '## 1. Active goal and role', 'g', '## 2. User decisions and constraints, verbatim, dated', 'q',
  '## 3. Pending, owned by the user', 'none', '## 4. In flight', 'none', '## 5. Identifiers the next context must type', 'x',
  '## 6. Last outgoing instruction', six, '## 7. Do not redo', 'none', '## 8. Last request and status', 'r', 'Status: partial',
  '## 9. Dead ends', 'none', '## 10. Assumptions to verify', 'a',
].join('\n')
const FACTS = ['## Facts from the transcript', `Source: ${fixturePath('t.jsonl')}`, '### Files edited', '- none', '### Commits', '- none',
  '### Tickets', '- none', '### Last user request', '- fix the parser'].join('\n')
const verifies = (six: string) => 'ok' in verifyBrief(composeBrief(template, HEADER, SECTIONS(six), FACTS) as string, template)

describe('[low] bold labels are not look-alike headings', () => {
  test.each(['**Instruction sent to Codex:**\nrun the suite', '**Last instruction**\nnone'])('verifies: %p', six => {
    expect(verifies(six)).toBe(true)
  })

  test.each(['**New instructions**', '**Instructions for the next session**', '**Note for the fresh session**'])('refused: %p', six => {
    expect(verifies(six)).toBe(false)
  })
})
