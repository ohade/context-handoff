import { fixturePath } from '../fixtures/paths'

// W7 Phase B, item G1 (audit P4: R1-F4, R2-F13). Written red-first.
// A seed submit that fails ends SEEDING at once through the fill fallback (strandSeed) instead of
// waiting the 120 s seed timeout. No such event existed: `seedFailed` is new and reuses strandSeed.
// The fallback's notice carries a second text for a prompt box that could not be filled.
import { describe, expect, test } from 'bun:test'

import { initialState, step } from '../../hooks/machine'
import type { Effect, MachineState } from '../../hooks/machine'
import { resolveConfig } from '../../hooks/config'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const BRIEF = fixturePath('briefs/b.md')
const CYCLE = `${SID}#1`
const T0 = 1_000_000
const config = resolveConfig({}, {}).config

const seeding: MachineState = {
  ...initialState(SID, T0, 'me'), phase: 'SEEDING', cycleId: CYCLE, briefPath: BRIEF, deadline: T0 + 120_000, seedVia: 'submit',
}
const types = (fx: Effect[]) => fx.map(f => f.type)

describe('[G1] seedFailed', () => {
  test('in SEEDING for this cycle: idle at once, the box is filled, and the notice has an unfilled text', () => {
    const r = step(seeding, { type: 'seedFailed', cycleId: CYCLE, now: T0 + 5, failure: 'HooksError: lost' }, config)
    expect(r.state.phase).toBe('IDLE')
    expect(r.effects).toContainEqual({ type: 'fillSeed', briefPath: BRIEF })
    const notice = r.effects.find(f => f.type === 'pinNotice') as { text: string; ifUnfilled?: string }
    expect(notice.text).toContain('press Enter')
    expect(notice.ifUnfilled).toContain(BRIEF)
    expect(notice.ifUnfilled).not.toContain('press Enter')
  })

  test('another cycle, or another phase, changes nothing', () => {
    expect(types(step(seeding, { type: 'seedFailed', cycleId: `${SID}#9`, now: T0, failure: 'x' }, config).effects)).not.toContain('fillSeed')
    const idle = initialState(SID, T0, 'me')
    expect(step(idle, { type: 'seedFailed', cycleId: CYCLE, now: T0, failure: 'x' }, config).state).toEqual(idle)
  })
})

describe('[G1 r1] the late-clear fill carries the unfilled notice too', () => {
  test('a /clear of the session whose clear timed out fills the box; its notice has ifUnfilled', () => {
    const NEW = '22222222-aaaa-4bbb-8ccc-000000000002'
    const late: MachineState = { ...initialState(SID, T0, 'me'), lastClearTimeout: { briefPath: BRIEF, at: T0, sessionId: SID } }
    const r = step(late, { type: 'sessionStart', sessionId: NEW, source: 'clear', now: T0 + 1_000 }, config)
    expect(r.effects).toContainEqual({ type: 'fillSeed', briefPath: BRIEF })
    const notice = r.effects.find(f => f.type === 'pinNotice') as { text: string; ifUnfilled?: string }
    expect(notice.ifUnfilled).toContain(BRIEF)
    expect(notice.ifUnfilled).not.toContain('press Enter')
  })
})
