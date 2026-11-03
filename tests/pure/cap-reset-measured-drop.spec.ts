import { fixturePath } from '../fixtures/paths'

// A compaction the mod's hooks never see (for example, idle compaction with multiple
// compact boundaries, no `compaction` log line) must still re-arm automatic handoff. A context drop
// of at least minGrowthTokens between two main turn ends of one session counts as a compaction for
// the caps; the backoff keeps its measured-drop rebase. A small drop does not. Namespace imports so a missing export fails its
// own test, not the file.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import * as guards from '../../hooks/guards'
import * as machine from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'

const { initialState, step } = machine
const SID = '11111111-aaaa-4bbb-8ccc-000000000002'
const T0 = 1_000_000
const CONFIG: HandoffConfig = { ...resolveConfig({}, {}).config, thresholdTokens: 400_000 }

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
const logs = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [`${e.event} ${e.detail}`] : []))
const turnEnd = (turnId: string, tokens: number, now: number): guards.TurnEndEvent =>
  ({ type: 'turnEnd', now, sessionId: SID, turnId, reason: 'answer', percent: Math.round(tokens / 10_000), tokens, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a' })
const capped = (): MachineState => ({
  ...initialState(SID, T0, 'owner-a'), transcriptPath: fixturePath('t.jsonl'), backgroundTasks: 0, sessionCrons: 0,
  failedCycles: 2, backoffTokens: 600_000, backoffKind: 'failure',
})
const capFields = (s: MachineState) => ({ failedCycles: s.failedCycles, unclearedRuns: s.unclearedRuns, backoffTokens: s.backoffTokens, backoffKind: s.backoffKind })
// backoff2.spec.ts pins that a measured drop rebases a failure backoff to the new size (growth is measured from there).
const REARMED = { failedCycles: 0, unclearedRuns: 0, backoffTokens: 250_000, backoffKind: 'failure' }

describe('a measured context drop resets the caps when no compaction event arrived', () => {
  test('a drop of at least minGrowthTokens between main turn ends clears the caps; the backoff is rebased, not lifted', () => {
    const out = run(capped(), [turnEnd('t1', 760_000, T0 + 10), turnEnd('t2', 250_000, T0 + 20)])
    expect(capFields(out.state)).toEqual(REARMED)
    expect(logs(out.effects).some(l => l.startsWith('compaction-inferred '))).toBe(true)
  })

  test('after the inferred reset, regrowth past the threshold no longer hits failure-cap', () => {
    const dropped = run(capped(), [turnEnd('t1', 760_000, T0 + 10), turnEnd('t2', 250_000, T0 + 20)]).state
    const regrown = run(dropped, [turnEnd('t3', 450_000, T0 + 30)])
    expect(logs(regrown.effects).some(l => l.includes('failure-cap ('))).toBe(false)
  })

  test('a drop smaller than minGrowthTokens keeps the cap', () => {
    const out = run(capped(), [turnEnd('t1', 760_000, T0 + 10), turnEnd('t2', 760_000 - CONFIG.minGrowthTokens + 1, T0 + 20)])
    expect(out.state.failedCycles).toBe(2)
    expect(logs(out.effects).some(l => l.startsWith('compaction-inferred '))).toBe(false)
  })

  test('the first measured turn end has nothing to compare with and keeps the cap', () => {
    const out = run(capped(), [turnEnd('t1', 250_000, T0 + 10)])
    expect(out.state.failedCycles).toBe(2)
  })

  test('a subagent turn end is not a main measurement and never infers a compaction', () => {
    const sub: MachineEvent = { ...turnEnd('s1', 10_000, T0 + 15), agentId: 'agent-1' }
    const out = run(capped(), [turnEnd('t1', 760_000, T0 + 10), sub])
    expect(out.state.failedCycles).toBe(2)
  })
})
