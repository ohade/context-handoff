// W2g item 1 (Phase 2 live check): an empty plugin option is unset. Written red-first.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'

const NUMERIC_OPTIONS = ['thresholdPercent', 'thresholdTokens', 'minGrowthTokens', 'maxAutoChain', 'autoRunTimeoutSeconds', 'autoRunToolCap', 'ceilingTokens', 'nudgeTurnLimit', 'clearGraceSeconds']

describe('item 1: an empty plugin option is unset', () => {
  test('the live default: thresholdPercent "" with thresholdTokens 400000 gives 400000 and no warning', () => {
    const { config, warnings } = resolveConfig({ thresholdPercent: '', thresholdTokens: 400_000 }, {})
    expect([config.thresholdPercent, config.thresholdTokens]).toEqual([null, 400_000])
    expect(warnings).toEqual([])
  })

  test('every numeric option set to "" or whitespace resolves exactly like an absent option, with no warning', () => {
    const absent = resolveConfig({}, {})
    for (const blank of ['', '   ', '\t']) {
      const options = Object.fromEntries(NUMERIC_OPTIONS.map(key => [key, blank]))
      const { config, warnings } = resolveConfig(options, {})
      expect(config).toEqual(absent.config)
      expect(warnings).toEqual([])
    }
  })

  test('an empty option does not hide a valid env value, and an empty env value is still unset', () => {
    const r = resolveConfig({ maxAutoChain: '' }, { CONTEXT_HANDOFF_MAX_AUTO_CHAIN: '1' })
    expect(r.config.maxAutoChain).toBe(1)
    const both = resolveConfig({ maxAutoChain: '' }, { CONTEXT_HANDOFF_MAX_AUTO_CHAIN: '' })
    expect([both.config.maxAutoChain, both.warnings]).toEqual([2, []])
  })

  test('a non-empty invalid option still warns', () => {
    const { config, warnings } = resolveConfig({ thresholdPercent: 'abc', maxAutoChain: ' x ' }, {})
    expect([config.thresholdPercent, config.thresholdTokens, config.maxAutoChain]).toEqual([null, 400_000, 2])
    expect(warnings).toEqual([
      'option maxAutoChain=" x " is not an integer in [0, 20]; ignored',
      'option thresholdPercent="abc" is not an integer in [1, 99]; ignored',
    ])
  })
})
