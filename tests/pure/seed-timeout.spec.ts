import { fixturePath } from '../fixtures/paths'

// Live test 2026-10-05: the seed entered 30.4 s after SEEDING began (18 SessionStart hooks ran
// first); the SEEDING timeout was 30 s, so only timing luck kept a second seed out of the prompt box.
import { describe, expect, test } from 'bun:test'

import { resolveConfig, TIMEOUTS_MS } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'
import type { MachineState } from '../../hooks/machine'

const NEW = '22222222-aaaa-bbbb-cccc-000000000002'
const T0 = 1_000_000
const CONFIG = resolveConfig({}, {}).config

function seeding(): MachineState {
  return {
    ...initialState(NEW, T0, 'owner-a'), phase: 'SEEDING', cycleId: 'old#1', enteredAt: T0,
    deadline: T0 + TIMEOUTS_MS.seed, briefPath: fixturePath('b.md'), verifiedCycleId: 'old#1', seedVia: 'submit',
  } as MachineState
}

describe('a slow seed is never filled twice', () => {
  test('the SEEDING timeout is well above real SessionStart hook latency (at least 120 s)', () => {
    expect(TIMEOUTS_MS.seed).toBeGreaterThanOrEqual(120_000)
  })

  test('a watchdog tick at 45 s fills nothing, and the seed delivered then ends the cycle', () => {
    const tick = step(seeding(), { type: 'tick', now: T0 + 45_000, isKillSwitchOn: false }, CONFIG)
    expect(tick.effects.some(e => e.type === 'fillSeed')).toBe(false)
    expect(tick.state.phase).toBe('SEEDING')
    const done = step(tick.state, { type: 'seedDelivered', cycleId: 'old#1', now: T0 + 45_001 }, CONFIG)
    expect(done.state.phase).toBe('IDLE')
    expect(done.effects.some(e => e.type === 'fillSeed')).toBe(false)
  })
})
