// Pure configuration for the context-handoff mod: no `$` calls here.
// register.tsx reads every env variable by its string-literal name (the engine
// requires literals) and hands the values to `resolveConfig`.

export type SeedVia = 'submit' | 'initial'

export type HandoffConfig = {
  /**
   * The automatic trigger, "whichever is set": exactly one of the two is non-null. A percent set by
   * env or option replaces the token default; CONTEXT_HANDOFF_THRESHOLD_TOKENS beats both.
   */
  thresholdTokens: number | null
  thresholdPercent: number | null
  minGrowthTokens: number
  maxAutoChain: number
  /** How long the automatic run (the skill turn) may take from auto-run-called; past it, a failed run. */
  autoRunTimeoutSeconds: number
  /** Tool calls the automatic run may make; past it, a failed run. */
  autoRunToolCap: number
  /** After the nudge: at this many context tokens the run starts at the next turn end with reason answer, clean or not. */
  ceilingTokens: number
  /** After the nudge: after this many turn ends the run starts at the next turn end with reason answer, clean or not. */
  nudgeTurnLimit: number
  clearGraceSeconds: number
  seedVia: SeedVia
  isDisabledByEnv: boolean
}

/** The env values register.tsx read, keyed by their literal names. */
export type HandoffEnv = {
  CONTEXT_HANDOFF_THRESHOLD_TOKENS?: string
  CONTEXT_HANDOFF_THRESHOLD_PERCENT?: string
  CONTEXT_HANDOFF_MIN_GROWTH_TOKENS?: string
  CONTEXT_HANDOFF_MAX_AUTO_CHAIN?: string
  CONTEXT_HANDOFF_AUTO_RUN_TIMEOUT_SECONDS?: string
  CONTEXT_HANDOFF_AUTO_RUN_TOOL_CAP?: string
  CONTEXT_HANDOFF_CEILING_TOKENS?: string
  CONTEXT_HANDOFF_NUDGE_TURN_LIMIT?: string
  CONTEXT_HANDOFF_CLEAR_GRACE_SECONDS?: string
  CONTEXT_HANDOFF_SEED_VIA?: string
  CONTEXT_HANDOFF_DISABLE?: string
}

export type ConfigResult = {
  config: HandoffConfig
  /** One entry per rejected value, for the log; the default was used instead. */
  warnings: string[]
}

type NumericKey = 'minGrowthTokens' | 'maxAutoChain' | 'autoRunTimeoutSeconds' | 'autoRunToolCap' | 'ceilingTokens' | 'nudgeTurnLimit' | 'clearGraceSeconds'

type Range = { envName: keyof HandoffEnv; min: number; max: number }
type NumericField = Range & { key: NumericKey; fallback: number }

/** Defaults match `.claude-plugin/plugin.json` `userConfig`. Ranges are inclusive integers. */
export const NUMERIC_FIELDS: readonly NumericField[] = [
  { key: 'minGrowthTokens', envName: 'CONTEXT_HANDOFF_MIN_GROWTH_TOKENS', fallback: 100_000, min: 0, max: 10_000_000 },
  { key: 'maxAutoChain', envName: 'CONTEXT_HANDOFF_MAX_AUTO_CHAIN', fallback: 2, min: 0, max: 20 },
  { key: 'autoRunTimeoutSeconds', envName: 'CONTEXT_HANDOFF_AUTO_RUN_TIMEOUT_SECONDS', fallback: 180, min: 30, max: 1_800 },
  { key: 'autoRunToolCap', envName: 'CONTEXT_HANDOFF_AUTO_RUN_TOOL_CAP', fallback: 15, min: 1, max: 100 },
  { key: 'ceilingTokens', envName: 'CONTEXT_HANDOFF_CEILING_TOKENS', fallback: 500_000, min: 1, max: 10_000_000 },
  { key: 'nudgeTurnLimit', envName: 'CONTEXT_HANDOFF_NUDGE_TURN_LIMIT', fallback: 3, min: 1, max: 20 },
  { key: 'clearGraceSeconds', envName: 'CONTEXT_HANDOFF_CLEAR_GRACE_SECONDS', fallback: 5, min: 1, max: 120 },
]

export const DEFAULT_THRESHOLD_TOKENS = 400_000
/** A ceiling not above the token threshold is replaced by the threshold plus this. */
export const CEILING_FALLBACK_MARGIN = 100_000
const TOKENS: Range = { envName: 'CONTEXT_HANDOFF_THRESHOLD_TOKENS', min: 1, max: 10_000_000 }
const PERCENT: Range = { envName: 'CONTEXT_HANDOFF_THRESHOLD_PERCENT', min: 1, max: 99 }

/** Fixed timeouts from the plan; not user-configurable. */
export const TIMEOUTS_MS = {
  clear: 30_000,
  newIdPoll: 5_000,
  carry: 10_000,
  // The seed enters only after every SessionStart hook ran (30.4 s seen live, 18 hooks): wait long.
  seed: 120_000,
  seedInitialFallback: 10_000,
  // A SessionStart(clear) this soon after a refused or timed-out clear (the user's own /clear, or a
  // late one) fills the seed into the prompt box: long enough for a person to read the notice and act.
  lateClear: 600_000,
  // A GRACE tick later than this past the deadline (sleep, a stalled loop) aborts instead of clearing.
  graceSlack: 5_000,
  // After the run's turn ended without handoff_now: how long a Stop-gate continuation may take to start.
  autoRunContinuation: 10_000,
} as const

function parseInteger(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined
  if (typeof raw !== 'string' || !/^\s*-?\d+\s*$/.test(raw)) return undefined
  return Number.parseInt(raw, 10)
}

/**
 * Precedence per numeric field: a valid env override, else a valid plugin
 * option, else the built-in default. An invalid value at any level is skipped
 * with a warning, so a typo never disables a guard.
 */
export function resolveConfig(options: Readonly<Record<string, unknown>>, env: HandoffEnv): ConfigResult {
  const warnings: string[] = []
  const numeric = {} as Record<NumericKey, number>
  for (const field of NUMERIC_FIELDS) {
    numeric[field.key] = firstValid(field, field.key, options[field.key], env[field.envName], warnings) ?? field.fallback
  }
  const seedRaw = env.CONTEXT_HANDOFF_SEED_VIA
  let seedVia: SeedVia = 'submit'
  if (seedRaw === 'initial') seedVia = 'initial'
  else if (seedRaw !== undefined && seedRaw !== '' && seedRaw !== 'submit') {
    warnings.push(`CONTEXT_HANDOFF_SEED_VIA=${JSON.stringify(seedRaw)} is not submit|initial; using submit`)
  }
  const threshold = resolveThreshold(options, env, warnings)
  if (threshold.thresholdTokens !== null && numeric.ceilingTokens <= threshold.thresholdTokens) {
    const fallback = threshold.thresholdTokens + CEILING_FALLBACK_MARGIN
    warnings.push(`ceilingTokens=${numeric.ceilingTokens} is not above thresholdTokens=${threshold.thresholdTokens}; using ${fallback}`)
    numeric.ceilingTokens = fallback
  }
  return {
    config: { ...threshold, ...numeric, seedVia, isDisabledByEnv: env.CONTEXT_HANDOFF_DISABLE === '1' },
    warnings,
  }
}

/**
 * "Whichever is set": the token env first, then a percent (env, then option), then the token option,
 * then the 400000-token default. plugin.json gives thresholdPercent no default, so a percent is
 * present only when someone set it.
 */
function resolveThreshold(options: Readonly<Record<string, unknown>>, env: HandoffEnv, warnings: string[]): Pick<HandoffConfig, 'thresholdTokens' | 'thresholdPercent'> {
  const tokenEnv = firstValid(TOKENS, 'thresholdTokens', undefined, env.CONTEXT_HANDOFF_THRESHOLD_TOKENS, warnings)
  if (tokenEnv !== null) return { thresholdTokens: tokenEnv, thresholdPercent: null }
  const percent = firstValid(PERCENT, 'thresholdPercent', options.thresholdPercent, env.CONTEXT_HANDOFF_THRESHOLD_PERCENT, warnings)
  if (percent !== null) return { thresholdTokens: null, thresholdPercent: percent }
  const tokens = firstValid(TOKENS, 'thresholdTokens', options.thresholdTokens, undefined, warnings)
  return { thresholdTokens: tokens ?? DEFAULT_THRESHOLD_TOKENS, thresholdPercent: null }
}

function firstValid(range: Range, key: string, option: unknown, envRaw: string | undefined, warnings: string[]): number | null {
  const candidates: Array<[string, unknown]> = [
    [range.envName, envRaw === '' ? undefined : envRaw],
    // An empty (or blank) option is unset: plugin.json gives an option with no default the value "".
    [`option ${key}`, typeof option === 'string' && option.trim() === '' ? undefined : option],
  ]
  for (const [source, raw] of candidates) {
    if (raw === undefined || raw === null) continue
    const value = parseInteger(raw)
    if (value !== undefined && value >= range.min && value <= range.max) return value
    warnings.push(`${source}=${JSON.stringify(raw)} is not an integer in [${range.min}, ${range.max}]; ignored`)
  }
  return null
}
