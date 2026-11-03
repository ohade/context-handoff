import { fixturePath } from '../fixtures/paths'

import { expect, test } from 'bun:test'
import { initialState, recoverAfterReload, step } from '../../hooks/machine'
import { resolveConfig } from '../../hooks/config'

test('reload after a seed may have entered keeps the brief visible without offering a duplicate seed', () => {
  const sid = '22222222-aaaa-4bbb-8ccc-000000000002'
  const state = { ...initialState(sid, 0, 'owner'), phase: 'SEEDING' as const, cycleId: 'cycle', deadline: 30_000, briefPath: fixturePath('brief.md'), clearingFrom: '11111111-aaaa-4bbb-8ccc-000000000001' }
  const result = recoverAfterReload(state, sid, 'owner', 1_000)
  expect(result.state.phase).toBe('IDLE')
  expect(result.effects.some(e => e.type === 'submitSeed' || e.type === 'fillSeed')).toBe(false)
  expect(JSON.stringify(result.effects)).toContain('delivery unknown')
  expect(JSON.stringify(result.effects)).toContain(fixturePath('brief.md'))
})

test('a seed delivery timeout never retries or fills an uncertain queued seed', () => {
  const sid = '22222222-aaaa-4bbb-8ccc-000000000002'
  const state = { ...initialState(sid, 0, 'owner'), phase: 'SEEDING' as const, cycleId: 'cycle', deadline: 1_000, briefPath: fixturePath('brief.md'), seedVia: 'initial' as const }
  const result = step(state, { type: 'tick', now: 2_000, isKillSwitchOn: false }, resolveConfig({}, {}).config)
  expect(result.state.phase).toBe('IDLE')
  expect(result.effects.some(e => e.type === 'submitSeed' || e.type === 'fillSeed')).toBe(false)
  expect(JSON.stringify(result.effects)).toContain('delivery unknown')
})
