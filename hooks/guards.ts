// The turn-end guards of the handoff machine, in order. Pure.
// Each answers a skip reason (logged once by the machine) or null to pass.
// `below-threshold` is the one reason the machine drops silently.

import type { HandoffConfig } from './config'
import type { MachineEvent, MachineState } from './machine-types'

export type TurnEndEvent = Extract<MachineEvent, { type: 'turnEnd' }>

type Guard = (state: MachineState, e: TurnEndEvent, config: HandoffConfig) => string | null

export const BELOW_THRESHOLD = 'below-threshold'
/** Failed cycles before automatic handoff stops until the next compaction or session: at most two wasted skill runs. */
export const FAILED_CYCLE_CAP = 2
/** Automatic runs that started and ended without a clear, for any reason, before the automatic path stops until the next compaction or session (the loop bound). */
export const UNCLEARED_RUN_CAP = 3

/**
 * 'run': the automatic path cannot run now, so no nudge either. 'turn': blocks a start at this turn
 * end only. 'clean': a turn end after the nudge that fails it waits (clean-wait); the ceiling
 * overrides none of them (it never starts a run over the user).
 */
type GuardKind = 'run' | 'turn' | 'clean'

/** A guard that reads no config: the clean conditions. */
type CleanCheck = (state: MachineState, e: TurnEndEvent) => string | null

/**
 * A Plannotator review open for this session (handoffs strand it: it reattaches only when the same
 * session resumes), or its state unreadable: the handoff waits; nothing is charged.
 */
export function plannotatorReason(e: Pick<TurnEndEvent, 'openReviews'>): string | null {
  if (e.openReviews === 'unknown') return 'plannotator-state-unknown'
  return e.openReviews > 0 ? `plannotator-review-open (${e.openReviews})` : null
}

/** `background-tasks (<n>[; <m> subagents])` for the log, or null when none run. */
export function backgroundBusyReason(s: MachineState): string | null {
  if (s.backgroundTasks === null) return 'activity-unknown'
  if (s.backgroundTasks <= 0) return null
  const subagents = s.runningSubagents > 0 ? `; ${s.runningSubagents} subagent${s.runningSubagents === 1 ? '' : 's'}` : ''
  return `background-tasks (${s.backgroundTasks}${subagents})`
}

const backgroundReason: CleanCheck = s => backgroundBusyReason(s)

const draftReason: CleanCheck = (_s, e) => (e.draft.trim() !== '' ? 'draft-in-prompt-box' : null)
const typedPendingReason: CleanCheck = (_s, e) => (e.isTypedPending === true ? 'pending-typed-prompt' : null)

const GUARDS: ReadonlyArray<readonly [GuardKind, Guard]> = [
  ['run', (_s, e) => (e.isKillSwitchOn ? 'kill-switch' : null)],
  ['run', thresholdGuard],
  ['clean', (_s, e) => (e.reason === 'aborted' ? 'turn-aborted' : e.reason === 'error' ? 'turn-error' : null)],
  ['run', (s, _e, c) =>
    s.autoChain >= c.maxAutoChain
      ? `max-auto-chain (${s.autoChain} handoffs since the last typed prompt, max ${c.maxAutoChain})`
      : null],
  ['run', minGrowth],
  ['run', (s) => (s.failedCycles >= FAILED_CYCLE_CAP ? `failure-cap (${s.failedCycles} failed cycles; off until the next compaction or session)` : null)],
  ['run', (s) => (s.unclearedRuns >= UNCLEARED_RUN_CAP ? `uncleared-run-cap (${s.unclearedRuns} automatic runs ended without a clear; off until the next compaction or session)` : null)],
  ['run', backoff],
  ['clean', draftReason],
  ['clean', backgroundReason],
  ['clean', typedPendingReason],
  ['turn', (s) => (s.sessionCrons === null ? 'activity-unknown' : s.sessionCrons > 0 ? `session-crons (${s.sessionCrons})` : null)],
  ['turn', (_s, e) => plannotatorReason(e)],
  ['turn', (s) => (s.transcriptPath === null ? 'transcript-unknown' : null)],
]

function firstOf(kinds: readonly GuardKind[], state: MachineState, e: TurnEndEvent, config: HandoffConfig): string | null {
  for (const [kind, guard] of GUARDS) {
    if (!kinds.includes(kind)) continue
    const reason = guard(state, e, config)
    if (reason !== null) return reason
  }
  return null
}

/** Stage 1: the first reason the automatic path could not run at all now (no nudge then), or null. */
export function guardNudge(state: MachineState, e: TurnEndEvent, config: HandoffConfig): string | null {
  return firstOf(['run'], state, e, config)
}

/** After the nudge: the first guard a turn end fails that the ceiling does not override, or null. */
export function guardHard(state: MachineState, e: TurnEndEvent, config: HandoffConfig): string | null {
  return firstOf(['run', 'turn'], state, e, config)
}

/** After the nudge: why this turn end is not clean (reason answer, no background tasks or subagents, no draft, no pending typed prompt), or null. */
export function uncleanReason(state: MachineState, e: TurnEndEvent): string | null {
  if (e.reason !== 'answer') return `turn-${e.reason}`
  return draftReason(state, e) ?? backgroundReason(state, e) ?? typedPendingReason(state, e)
}

/** Whether a measurement reaches the threshold: register.tsx dispatches a tool result's size only then (no state write per call). */
export function reachesThreshold(state: MachineState, measured: Pick<TurnEndEvent, 'tokens' | 'percent'>, config: HandoffConfig): boolean {
  return thresholdGuard(state, measured, config) === null
}

/** The ceiling's one exception: never while background tasks (subagents included) run. */
export function isBackgroundBusy(state: MachineState): boolean {
  return state.backgroundTasks === null || state.backgroundTasks > 0
}

/** The token trigger when thresholdTokens is set, else the percent trigger. */
function thresholdGuard(_s: MachineState, e: Pick<TurnEndEvent, 'tokens' | 'percent'>, c: HandoffConfig): string | null {
  if (c.thresholdTokens !== null) {
    if (e.tokens === undefined || !Number.isFinite(e.tokens)) return 'tokens-unknown'
    return e.tokens < c.thresholdTokens ? BELOW_THRESHOLD : null
  }
  if (e.percent === undefined || !Number.isFinite(e.percent)) return 'percent-unknown'
  return e.percent < (c.thresholdPercent as number) ? BELOW_THRESHOLD : null
}

/** Applies only to a session a handoff created: it stops a handoff loop. */
function minGrowth(state: MachineState, e: TurnEndEvent, config: HandoffConfig): string | null {
  if (state.previousSessionId === null) return null
  const grown = e.tokens === undefined || state.baseTokens === null ? 0 : e.tokens - state.baseTokens
  if (grown >= config.minGrowthTokens) return null
  return `min-growth (${grown} < ${config.minGrowthTokens} tokens since the first measured turn end)`
}

/** After a cycle ended before the clear: wait for minGrowthTokens of growth past its start (or a typed prompt). */
function backoff(state: MachineState, e: TurnEndEvent, config: HandoffConfig): string | null {
  if (state.backoffTokens === null) return null
  const grown = e.tokens === undefined ? 0 : e.tokens - state.backoffTokens
  if (grown >= config.minGrowthTokens) return null
  const lift = state.backoffKind === 'cancel' ? '; a typed prompt lifts it' : ''
  return `backoff (${state.backoffKind ?? 'cancel'}: ${Math.max(grown, 0)} < ${config.minGrowthTokens} tokens since the last cycle that did not clear${lift})`
}

/**
 * The guards a queued brief keeps at the end of its turn (it skips threshold, growth, chain, caps and
 * backoff). The brief is written, so the cycle has started: only a confirmed open review stops it, and
 * an unknown read does not (amendment A2: unknown holds only at cycle start).
 */
export function guardManual(state: MachineState, e: TurnEndEvent): string | null {
  if (e.isKillSwitchOn) return 'kill-switch is on'
  if (e.draft.trim() !== '') return 'a draft is in the prompt box'
  if (state.backgroundTasks === null || state.sessionCrons === null) return 'activity-unknown'
  if (state.backgroundTasks > 0) return `${state.backgroundTasks} background task(s) are running`
  if (state.sessionCrons > 0) return `${state.sessionCrons} session cron(s) are scheduled`
  return e.openReviews !== 'unknown' && e.openReviews > 0 ? plannotatorRefusal(e.openReviews) : null
}

/** Why a manual handoff (pending, or handoff_now before its brief) does not go ahead, or null. */
export function plannotatorRefusal(openReviews: number | 'unknown'): string | null {
  if (openReviews === 'unknown') return 'Plannotator state is unknown'
  return openReviews > 0 ? 'a Plannotator review is open' : null
}

/** The first guard that fires, or null to start a cycle. */
export function guardTurnEnd(state: MachineState, e: TurnEndEvent, config: HandoffConfig): string | null {
  return firstOf(['run', 'turn', 'clean'], state, e, config)
}
