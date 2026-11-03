import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'

describe('resolveConfig', () => {
  test('defaults match the plan', () => {
    const { config, warnings } = resolveConfig({}, {})
    expect(config).toEqual({
      thresholdPercent: null,
      thresholdTokens: 400_000,
      minGrowthTokens: 100_000,
      maxAutoChain: 2,
      autoRunTimeoutSeconds: 180,
      autoRunToolCap: 15,
      ceilingTokens: 500_000,
      nudgeTurnLimit: 3,
      clearGraceSeconds: 5,
      seedVia: 'submit',
      isDisabledByEnv: false,
    })
    expect(warnings).toEqual([])
  })

  test('plugin options override defaults; env overrides options', () => {
    const options = { thresholdPercent: 80, minGrowthTokens: 50_000, maxAutoChain: 1, autoRunTimeoutSeconds: 120, clearGraceSeconds: 3 }
    expect(resolveConfig(options, {}).config.thresholdPercent).toBe(80)
    const env = {
      CONTEXT_HANDOFF_THRESHOLD_PERCENT: '60',
      CONTEXT_HANDOFF_MIN_GROWTH_TOKENS: '0',
      CONTEXT_HANDOFF_MAX_AUTO_CHAIN: '0',
      CONTEXT_HANDOFF_AUTO_RUN_TIMEOUT_SECONDS: '30',
      CONTEXT_HANDOFF_CLEAR_GRACE_SECONDS: '1',
    }
    const { config, warnings } = resolveConfig(options, env)
    expect([config.thresholdPercent, config.minGrowthTokens, config.maxAutoChain, config.autoRunTimeoutSeconds, config.clearGraceSeconds])
      .toEqual([60, 0, 0, 30, 1])
    expect(warnings).toEqual([])
  })

  test('an invalid env value falls back to the option, then the default, with a warning each', () => {
    const r = resolveConfig({ thresholdPercent: 85 }, { CONTEXT_HANDOFF_THRESHOLD_PERCENT: 'seventy' })
    expect(r.config.thresholdPercent).toBe(85)
    expect(r.warnings).toHaveLength(1)
    // Neither percent is valid: the threshold falls back to the token default, not to a percent.
    const both = resolveConfig({ thresholdPercent: 0 }, { CONTEXT_HANDOFF_THRESHOLD_PERCENT: '150' })
    expect([both.config.thresholdPercent, both.config.thresholdTokens]).toEqual([null, 400_000])
    expect(both.warnings).toHaveLength(2)
  })

  test('non-integers, negatives and empty env strings are not accepted', () => {
    expect(resolveConfig({}, { CONTEXT_HANDOFF_MIN_GROWTH_TOKENS: '-5' }).config.minGrowthTokens).toBe(100_000)
    expect(resolveConfig({}, { CONTEXT_HANDOFF_AUTO_RUN_TIMEOUT_SECONDS: '2.5' }).config.autoRunTimeoutSeconds).toBe(180)
    expect(resolveConfig({ maxAutoChain: 1.5 }, {}).config.maxAutoChain).toBe(2)
    const empty = resolveConfig({}, { CONTEXT_HANDOFF_CLEAR_GRACE_SECONDS: '' })
    expect(empty.config.clearGraceSeconds).toBe(5)
    expect(empty.warnings).toEqual([])
  })

  test('seed via and the kill switch env', () => {
    expect(resolveConfig({}, { CONTEXT_HANDOFF_SEED_VIA: 'initial' }).config.seedVia).toBe('initial')
    const bad = resolveConfig({}, { CONTEXT_HANDOFF_SEED_VIA: 'paste' })
    expect(bad.config.seedVia).toBe('submit')
    expect(bad.warnings).toHaveLength(1)
    expect(resolveConfig({}, { CONTEXT_HANDOFF_DISABLE: '1' }).config.isDisabledByEnv).toBe(true)
    expect(resolveConfig({}, { CONTEXT_HANDOFF_DISABLE: 'true' }).config.isDisabledByEnv).toBe(false)
  })
})
