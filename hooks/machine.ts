// The handoff state machine: pure, no `$` calls, no clock reads.
// register.tsx feeds it events (with the time) and executes the effects it
// returns. Every state but IDLE has a deadline stored in the state itself, so
// the watchdog (`tick`), late results and hot-reload recovery all work from
// the persisted file. Guards live in guards.ts, file encoding in state-file.ts.
//
// One brief writer: the /compact-crafter skill run. Manual: the user types it (handoff_now's
// composer door). Automatic: at the threshold the mod runs the skill itself (BRIEFING), binds the
// run's turn, and handoff_now's armed door accepts the brief from that turn only.

import { TIMEOUTS_MS } from './config'
import type { HandoffConfig } from './config'
import { backgroundBusyReason, BELOW_THRESHOLD, FAILED_CYCLE_CAP, guardHard, guardManual, guardNudge, guardTurnEnd, isBackgroundBusy, plannotatorReason, UNCLEARED_RUN_CAP, uncleanReason } from './guards'
import type { TurnEndEvent } from './guards'
import { decisionHoldReason, NOTES_ONLY } from './decision-hold'
import { backgroundHoldNotice, backgroundReminderText, nudgeText } from './nudge'
import { needsRetroCarry } from './retro-latch'
import { HANDOFF_COMMAND } from './handoff-now'

export type {
  AutoRun,
  CancelReason,
  Effect,
  MachineEvent,
  MachineState,
  MarkerSnapshot,
  Phase,
  Step,
  TurnEndReason,
  TurnOrigin,
} from './machine-types'
import type { AutoRun, CycleEvent, Effect, EventOf, MachineEvent, MachineState, Nudge, Phase, Step, CancelReason } from './machine-types'

/** The phases in which a brief exists and the clear is imminent: the only veto window. */
const VETO_PHASES: readonly Phase[] = ['GRACE', 'CLEARING']
/** Phases a typed prompt, Cancel, another turn or a session change can still stop. */
const CANCELLABLE_PHASES: readonly Phase[] = ['BRIEFING', 'GRACE']

/** Before the clear: the phases a typed prompt or the kill switch can still stop with no /clear issued. */
export function isBeforeClear(phase: Phase): boolean {
  return CANCELLABLE_PHASES.includes(phase)
}
/** Built-in compaction triggers the veto applies to; a user's /compact and plugin compactions pass. */
const VETOED_TRIGGERS: readonly string[] = ['auto', 'precompute']
/**
 * What the run's turn.start text carries live: the expanded command
 * markup, never the raw `/compact-crafter …` line.
 */
export const AUTO_RUN_MARKUP = `<command-message>${HANDOFF_COMMAND.slice(1)}</command-message>`

export function initialState(sessionId: string, now: number, ownerId: string): MachineState {
  return {
    version: 1,
    phase: 'IDLE',
    sessionId,
    ownerId,
    loadId: '',
    cycleSeq: 0,
    cycleId: null,
    enteredAt: now,
    deadline: null,
    autoChain: 0,
    baseTokens: null,
    previousSessionId: null,
    lastResponse: null,
    responseReplay: null,
    backgroundTasks: 0,
    runningSubagents: 0,
    nudge: null,
    sessionCrons: 0,
    transcriptPath: null,
    lastClearTimeout: null,
    backoffTokens: null,
    backoffKind: null,
    failedCycles: 0,
    unclearedRuns: 0,
    lastTokens: null,
    lastRunEnd: null,
    ...emptyCycle(),
  }
}

type CycleFields =
  | 'markers' | 'hasMarkerSnapshot' | 'briefPath' | 'autoRun'
  | 'verifiedCycleId' | 'clearingFrom' | 'isSuperseded' | 'seedVia' | 'isSeedFallbackUsed' | 'triggerTurnId' | 'isManual' | 'manualPending'
  | 'cycleStartTokens'

function emptyCycle(): Pick<MachineState, CycleFields> {
  return {
    markers: null,
    hasMarkerSnapshot: false,
    briefPath: null,
    verifiedCycleId: null,
    clearingFrom: null,
    isSuperseded: false,
    triggerTurnId: null,
    cycleStartTokens: null,
    seedVia: null,
    isSeedFallbackUsed: false,
    isManual: false,
    manualPending: null,
    autoRun: null,
  }
}

function logEffect(event: string, detail: string): Effect {
  return { type: 'log', event, detail }
}

const noop = (state: MachineState): Step => ({ state, effects: [] })

function enter(state: MachineState, phase: Phase, now: number, timeoutMs: number | null): MachineState {
  return { ...state, phase, enteredAt: now, deadline: timeoutMs === null ? null : now + timeoutMs }
}

function isPastDeadline(state: MachineState, now: number): boolean {
  return state.deadline !== null && now >= state.deadline
}

/** Back to IDLE, dropping the cycle; long-lived counters stay. */
function toIdle(state: MachineState, now: number): MachineState {
  return { ...enter(state, 'IDLE', now, null), cycleId: null, ...emptyCycle() }
}

/** Aborts that mean the attempt failed (a typed prompt does not lift their backoff); others are cancels. */
const FAILURE_EVENTS: ReadonlySet<string> = new Set([
  'auto-run-timeout', 'auto-run-failed',
  'clear-rejected', 'new-id-missing', 'clear-timeout', 'clear-abandoned',
])
const FAILURE_CANCELS: ReadonlySet<CancelReason> = new Set(['stop-blocked', 'persist-failed'])
type BackoffKind = NonNullable<MachineState['backoffKind']>

/** The backoff a cancel reason leaves: a failure, "not now" (the Cancel button), or a plain cancel. */
function cancelKind(reason: CancelReason): BackoffKind {
  if (FAILURE_CANCELS.has(reason)) return 'failure'
  return reason === 'button' ? 'not-now' : 'cancel'
}

/**
 * Back to IDLE. A cycle that ends before or during the clear (the session id is still the old one)
 * backs off, because each automatic run is a full skill turn: a failure counts toward the
 * failure cap (reset by a compaction or a new session); unknown start tokens wait for a typed
 * prompt (cancel) or growth from a later measurement (failure, rebased in onTurnEnd).
 */
function abort(state: MachineState, now: number, event: string, detail: string, extra: Effect[] = [], kind?: BackoffKind): Step {
  const effects: Effect[] = [logEffect(event, `${state.cycleId ?? '-'} ${state.phase}: ${detail}`), ...extra]
  if (state.phase === 'GRACE') effects.push({ type: 'hideBand' })
  const idle = { ...toIdle(state, now), lastRunEnd: runEndOf(state, now, event) }
  // A manual handoff is the user's request: none of its ends charge the automatic path's budgets.
  if (state.isManual || (!CANCELLABLE_PHASES.includes(state.phase) && state.phase !== 'CLEARING')) return { state: idle, effects }
  const backoffKind = kind ?? (FAILURE_EVENTS.has(event) ? 'failure' : 'cancel')
  const failedCycles = state.failedCycles + (backoffKind === 'failure' ? 1 : 0)
  if (backoffKind === 'failure' && failedCycles === FAILED_CYCLE_CAP) {
    effects.push({
      type: 'pinNotice',
      text: `context-handoff: ${failedCycles} handoff attempts failed, so automatic handoff is off until the next compaction or session; built-in compaction stays in charge. Details: handoff.log in ~/.claude/state/context-handoff/`,
    })
  }
  const unclearedRuns = state.unclearedRuns + (isRunStarted(state) ? 1 : 0)
  if (isRunStarted(state) && unclearedRuns === UNCLEARED_RUN_CAP) {
    effects.push({
      type: 'pinNotice',
      text: `context-handoff: ${unclearedRuns} automatic runs ended without a clear, so automatic handoff is off until the next compaction or session; built-in compaction stays in charge. Details: handoff.log in ~/.claude/state/context-handoff/`,
    })
  }
  return { state: { ...idle, backoffTokens: state.cycleStartTokens ?? Number.MAX_SAFE_INTEGER, backoffKind, failedCycles, unclearedRuns }, effects }
}

/** The run end an abort records: the run's cycle and turns when a run had started, else the previous record. */
function runEndOf(state: MachineState, now: number, event: string): MachineState['lastRunEnd'] {
  if (!isRunStarted(state) || state.cycleId === null) return state.lastRunEnd
  return { cycleId: state.cycleId, turnIds: [...(state.autoRun?.turnIds ?? [])], event, at: now }
}

/** An automatic cycle whose skill run started (auto-run-called): BRIEFING after the call, or its GRACE or CLEARING. */
function isRunStarted(state: MachineState): boolean {
  if (state.isManual) return false
  if (state.phase === 'BRIEFING') return state.autoRun !== null && state.autoRun.calledAt !== null
  return state.phase === 'GRACE' || state.phase === 'CLEARING'
}

/** The clear did not run: the user can run it; their /clear (seen within lateClear) fills the seed. */
function clearByHandNotice(state: MachineState): Effect[] {
  return state.briefPath === null ? [] : [{ type: 'pinNotice', text: `context-handoff: the clear did not run; run /clear, then press Enter to start from the brief ${state.briefPath}` }]
}

function briefNotice(state: MachineState, lead: string): Effect[] {
  return state.briefPath === null ? [] : [{ type: 'pinNotice', text: `context-handoff: ${lead}; the brief is ${state.briefPath}` }]
}

/** What a later /clear of this session reads (rebase); TRACK-23 v3 (E4): with the cycle's /retro latch. */
function clearTimeoutOf(state: MachineState, now: number): NonNullable<MachineState['lastClearTimeout']> {
  return { briefPath: state.briefPath, at: now, sessionId: state.sessionId, retro: state.markers?.retro ?? null }
}

// ---- cycle start -------------------------------------------------------------

/** Rebases the long-lived measurements on a turn end or a compaction request. */
function measure(state: MachineState, tokens: number | undefined): MachineState {
  let s = state
  if (s.baseTokens === null && tokens !== undefined) s = { ...s, baseTokens: tokens }
  // A compaction (or a first measurement after an unknown start) brings the context below the backoff base: measure growth from here.
  if (s.backoffTokens !== null && tokens !== undefined && tokens < s.backoffTokens) s = { ...s, backoffTokens: tokens }
  return s
}

/** IDLE, guards passed: arm the automatic run (BRIEFING) and start the skill. */
function startAutoRun(s: MachineState, now: number, tokens: number | undefined, turnId: string | null, config: HandoffConfig, why: Effect): Step {
  const cycleSeq = s.cycleSeq + 1
  const cycleId = `${s.sessionId}#${cycleSeq}`
  const autoRun: AutoRun = { calledAt: null, isSubmitSeen: false, turnIds: [], isWaiting: false, isStopBlocked: false }
  const next: MachineState = {
    ...enter(s, 'BRIEFING', now, config.autoRunTimeoutSeconds * 1000),
    cycleSeq,
    cycleId,
    ...emptyCycle(),
    autoRun,
    triggerTurnId: turnId,
    lastClearTimeout: null,
    cycleStartTokens: tokens ?? null,
    backoffTokens: null,
    backoffKind: null,
    nudge: null,
  }
  return { state: next, effects: [why, { type: 'startAutoRun', cycleId }] }
}

function briefingLog(s: MachineState, e: { percent?: number; tokens?: number }): Effect {
  return logEffect('briefing', `${s.sessionId}#${s.cycleSeq + 1} at ${e.percent ?? '?'}% (${e.tokens ?? '?'} tokens), bg=${s.backgroundTasks}`)
}

/** Stage 1: the first main tool result at the threshold, with the automatic path able to run, nudges once. */
function onContextMeasured(state: MachineState, e: EventOf<'contextMeasured'>, config: HandoffConfig): Step {
  const isOpen = state.phase === 'IDLE' && state.manualPending === null && state.nudge === null
  if (!isOpen || e.agentId !== undefined || e.sessionId !== state.sessionId) return noop(state)
  const asTurnEnd: TurnEndEvent = { ...e, type: 'turnEnd', reason: 'answer', draft: '', answer: '' }
  if (guardNudge(state, asTurnEnd, config) !== null) return noop(state)
  return {
    state: { ...state, nudge: { at: e.now, tokens: e.tokens ?? null, turnEnds: 0 } },
    effects: [
      logEffect('nudged', `${state.sessionId} at ${e.tokens ?? '?'} tokens (${e.percent ?? '?'}%): one nudge with the tool result; the run waits for a clean turn end`),
      { type: 'nudge', text: nudgeText(e.tokens, e.percent) },
      { type: 'precomputeFacts', sessionId: state.sessionId },
    ],
  }
}

/** Why the ceiling forces the run at this turn end (tokens, or turn ends since the nudge), or null. */
function ceilingReason(nudge: Nudge, e: TurnEndEvent, config: HandoffConfig): string | null {
  if (e.tokens !== undefined && e.tokens >= config.ceilingTokens) return `${e.tokens} tokens >= ceiling ${config.ceilingTokens}`
  if (nudge.turnEnds >= config.nudgeTurnLimit) return `${nudge.turnEnds} turn ends since the nudge (limit ${config.nudgeTurnLimit})`
  return null
}

/**
 * TRACK-25 U2: a clean turn end with an open 👉 decision and no Track waiting row (0 or unknown) does
 * not start the run. `s` carries the advanced counter, `before` the nudge as it was. The window's first
 * held end re-arms the nudge once; every held end pins why; at the ceiling or the turn limit the run starts
 * anyway, flagged so the unregistered item is kept as notes only (runtime-only, register.tsx).
 */
function holdForDecision(s: MachineState, before: Nudge, e: EventOf<'turnEnd'>, config: HandoffConfig): Step | null {
  if (decisionHoldReason(s, e) === null) return null
  const limit = ceilingReason(before, e, config)
  if (limit !== null) {
    const started = startAutoRun(s, e.now, e.tokens, e.turnId ?? null, config, briefingLog(s, e))
    const effects = started.effects.map((effect): Effect => (effect.type === 'startAutoRun' ? { ...effect, decisionLimitReached: true } : effect))
    return {
      state: started.state,
      effects: [
        logEffect('decision-limit', `${limit}; decision-unregistered: running anyway`),
        { type: 'pinNotice', text: `context-handoff: an open 👉 decision is still not a waiting step in Track (${limit}); the handoff runs anyway and keeps it as ${NOTES_ONLY}.` },
        ...effects,
      ],
    }
  }
  const held = before.turnEnds + 1
  const effects: Effect[] = [logEffect('clean-wait', `decision-unregistered (turn end ${held} since the nudge)`)]
  // Once per window, on its first held end, whatever ended before it: register.tsx names the window it re-armed.
  if (e.rearmedWindow !== before.at) {
    effects.push(
      { type: 'nudge', text: nudgeText(e.tokens, e.percent), rearmedWindow: before.at },
      logEffect('nudge-rearmed', `${s.sessionId}: the ask rides the next tool result once`),
    )
  }
  effects.push({
    type: 'pinNotice',
    text: `context-handoff: the handoff waits (turn end ${held} of ${config.nudgeTurnLimit}): an open 👉 decision is not a waiting step in Track yet; after that it runs anyway and keeps it as ${NOTES_ONLY}.`,
  })
  return { state: s, effects }
}

/** Stage 2: after the nudge the run starts only at a clean turn end; the ceiling and the turn limit only log why it still waits. */
function onNudgedTurnEnd(state: MachineState, e: EventOf<'turnEnd'>, config: HandoffConfig): Step {
  const nudge = state.nudge as Nudge
  const s: MachineState = { ...state, nudge: { ...nudge, turnEnds: nudge.turnEnds + 1 } }
  const hard = guardHard(state, e, config)
  if (hard === BELOW_THRESHOLD) return noop(s)
  if (hard !== null) {
    const skip = logEffect('guard-skip', `${hard} at ${e.percent ?? '?'}%`)
    // A review holds the handoff past the ceiling too (the ceiling never overrides a 'turn' guard): one notice says so.
    const isHeldPastCeiling = hard === plannotatorReason(e) && ceilingReason(nudge, e, config) !== null
    return { state: s, effects: isHeldPastCeiling ? [skip, { type: 'reviewHeld', reason: hard }] : [skip] }
  }
  const unclean = uncleanReason(state, e)
  if (unclean === null) return holdForDecision(s, nudge, e, config) ?? startAutoRun(s, e.now, e.tokens, e.turnId ?? null, config, briefingLog(s, e))
  const ceiling = ceilingReason(nudge, e, config)
  if (ceiling === null || e.reason !== 'answer') return { state: s, effects: [logEffect('clean-wait', `${unclean} (turn end ${nudge.turnEnds + 1} since the nudge)`)] }
  // The ceiling never starts a run over the user. Background tasks, a draft
  // and a pending typed prompt all hold it, so past the ceiling the run still starts at the first
  // clean turn end; the ceiling only names why it is waiting.
  if (!isBackgroundBusy(state)) return { state: s, effects: [logEffect('ceiling-waiting-user', `${ceiling}; ${unclean}`)] }
  // TRACK-33: a lead that keeps dispatching never ends a turn with nothing running, so each held end says
  // what holds the run, to the person (a notice) and to the model (one line with the next tool result).
  return {
    state: s,
    effects: [
      logEffect('ceiling-waiting-bg', `${ceiling}; ${unclean}`),
      { type: 'pinNotice', text: backgroundHoldNotice(state.backgroundTasks) },
      { type: 'backgroundReminder', text: backgroundReminderText() },
    ],
  }
}

function onTurnEnd(state: MachineState, e: EventOf<'turnEnd'>, config: HandoffConfig): Step {
  if (e.agentId !== undefined) return noop(state)
  const changed = inferCompaction(changeSession(state, e.sessionId, e.now, 'turn-end', config), e, config)
  const s = rememberResponse(measure(changed.state, e.tokens), e)
  const after = (step: Step): Step => ({ state: step.state, effects: [...changed.effects, ...step.effects] })
  if (s.phase === 'BRIEFING' && s.autoRun !== null) return after(onRunTurnEnd(s, e, config))
  if (CANCELLABLE_PHASES.includes(s.phase) && e.turnId !== undefined && e.turnId !== s.triggerTurnId) {
    // Another main turn ran (a Stop-gate continuation, a wake) during the countdown: it would miss that work.
    return after(cancelIfPending(s, e.now, 'other-turn', ` (turn ${e.turnId} ended)`))
  }
  if (s.phase !== 'IDLE') return { state: s, effects: changed.effects }
  if (s.manualPending !== null) return after(startManual(s, e, config))
  if (s.nudge !== null) return after(onNudgedTurnEnd(s, e, config))
  // No nudge (no main tool result reached the threshold): this turn end is already the stop it asks for.
  const skip = guardTurnEnd(s, e, config)
  if (skip === BELOW_THRESHOLD) return { state: s, effects: changed.effects }
  if (skip !== null) return { state: s, effects: [...changed.effects, logEffect('guard-skip', `${skip} at ${e.percent ?? '?'}%`)] }
  // TRACK-25: an un-nudged decision turn opens the nudge counter, so both branches share one bound.
  const opened: Nudge = { at: e.now, tokens: e.tokens ?? null, turnEnds: 0 }
  const held = holdForDecision({ ...s, nudge: { ...opened, turnEnds: 1 } }, opened, e, config)
  if (held !== null) return after(held)
  return after(startAutoRun(s, e.now, e.tokens, e.turnId ?? null, config, briefingLog(s, e)))
}

/**
 * A context drop of minGrowthTokens or more between two main turn ends of this session is a
 * compaction the hooks did not report (for example, idle compaction with multiple compact
 * boundaries, no `compaction` log line, the failure cap never cleared). It re-arms the caps and the
 * nudge window as `compacted` does; the backoff keeps measure()'s rebase, and nothing is cancelled.
 */
function inferCompaction(changed: Step, e: EventOf<'turnEnd'>, config: HandoffConfig): Step {
  const s = changed.state
  if (e.tokens === undefined || e.sessionId !== s.sessionId) return changed
  const measured: MachineState = { ...s, lastTokens: e.tokens }
  if (s.lastTokens === null || s.lastTokens - e.tokens < config.minGrowthTokens) return { state: measured, effects: changed.effects }
  return {
    state: { ...measured, failedCycles: 0, unclearedRuns: 0, nudge: null },
    effects: [...changed.effects, logEffect('compaction-inferred', `${s.sessionId} context ${s.lastTokens} -> ${e.tokens} tokens with no compaction event; caps reset`)],
  }
}

function rememberResponse(state: MachineState, e: Pick<EventOf<'turnEnd'>, 'sessionId' | 'turnId' | 'reason' | 'answer' | 'isHandoffTurn' | 'agentId'>): MachineState {
  if (e.sessionId !== state.sessionId || e.agentId !== undefined || e.reason !== 'answer' ||
    e.turnId === undefined || e.answer.trim() === '' || e.isHandoffTurn ||
    state.phase === 'BRIEFING' || state.manualPending?.turnId === e.turnId) return state
  return { ...state, lastResponse: { sessionId: e.sessionId, turnId: e.turnId, text: e.answer } }
}

function onReplayAttempt(state: MachineState, e: EventOf<'responseReplayAttempt'>): Step {
  const replay = state.responseReplay
  if (replay?.status !== 'pending' || replay.cycleId !== e.cycleId ||
    state.sessionId !== e.destinationSession || replay.destinationSession !== e.destinationSession) return noop(state)
  return noop({ ...state, responseReplay: { ...replay, status: 'attempted', attemptId: e.attemptId } })
}

function onReplayReceipt(state: MachineState, e: EventOf<'responseReplayReceipt'>): Step {
  const replay = state.responseReplay
  if (replay?.status !== 'attempted' || replay.cycleId !== e.cycleId || replay.attemptId !== e.attemptId ||
    state.sessionId !== e.destinationSession || replay.destinationSession !== e.destinationSession) return noop(state)
  return noop({ ...state, responseReplay: { ...replay, status: e.uuid === null ? 'refused' : 'shown', uuid: e.uuid } })
}

/** session.compact trigger auto: in IDLE with the guards passing, arm the run once instead of compacting. */
function onCompactRequested(state: MachineState, e: EventOf<'compactRequested'>, config: HandoffConfig): Step {
  if (state.phase !== 'IDLE' || state.manualPending !== null || e.sessionId !== state.sessionId) return noop(state)
  const s = measure(state, e.tokens)
  const asTurnEnd: TurnEndEvent = { ...e, type: 'turnEnd', reason: 'answer', answer: '' }
  const skip = guardTurnEnd(s, asTurnEnd, config)
  if (skip !== null) return { state: s, effects: skip === BELOW_THRESHOLD ? [] : [logEffect('guard-skip', `${skip} at auto compaction`)] }
  const why = logEffect('armed-by-compaction', `${s.sessionId}#${s.cycleSeq + 1} at ${e.percent ?? '?'}% (${e.tokens ?? '?'} tokens); compaction skipped once`)
  return startAutoRun(s, e.now, e.tokens, null, config, why)
}

/** A turn end in BRIEFING: only the run's own turns matter; a brief from one of them enters GRACE. */
function onRunTurnEnd(s: MachineState, e: EventOf<'turnEnd'>, config: HandoffConfig): Step {
  const run = s.autoRun as AutoRun
  if (e.turnId === undefined || !run.turnIds.includes(e.turnId)) {
    return { state: s, effects: [logEffect('auto-run-other-turn', `${s.cycleId} turn ${e.turnId ?? '?'} ended; not the run`)] }
  }
  if (s.manualPending !== null && run.turnIds.includes(s.manualPending.turnId)) return startAutoGrace(s, e, config)
  if (e.reason !== 'answer') return abort(s, e.now, 'auto-run-failed', `run turn ${e.turnId} ended with ${e.reason} before handoff_now`)
  const waiting: MachineState = { ...s, autoRun: { ...run, isWaiting: true }, deadline: Math.min(s.deadline ?? Infinity, e.now + TIMEOUTS_MS.autoRunContinuation) }
  return { state: waiting, effects: [logEffect('auto-run-turn-ended', `${s.cycleId} turn ${e.turnId} ended without handoff_now; waiting for a continuation`)] }
}

/** The run turn that queued the brief ended: GRACE, charged as an automatic cycle. */
function startAutoGrace(s: MachineState, e: EventOf<'turnEnd'>, config: HandoffConfig): Step {
  const pending = s.manualPending as NonNullable<MachineState['manualPending']>
  if (e.reason !== 'answer') return abort(s, e.now, 'auto-run-failed', `run turn ${e.turnId} ended with ${e.reason}`)
  const why = guardManual(s, e)
  if (why !== null) return abort(s, e.now, 'cancelled', `${why}; the brief is ${pending.path}`)
  const next: MachineState = {
    ...enter(s, 'GRACE', e.now, config.clearGraceSeconds * 1000),
    manualPending: null,
    autoRun: null,
    briefPath: pending.path,
    verifiedCycleId: s.cycleId,
    markers: pending.markers,
    hasMarkerSnapshot: true,
    triggerTurnId: e.turnId ?? null,
  }
  return {
    state: next,
    effects: [
      logEffect('grace', `${s.cycleId} automatic brief ${pending.path}, ${config.clearGraceSeconds}s`),
      { type: 'showGrace', cycleId: s.cycleId as string, deadline: next.deadline as number },
    ],
  }
}

function onManualBrief(state: MachineState, e: EventOf<'manualBrief'>): Step {
  if (state.phase === 'BRIEFING' && state.autoRun !== null && state.manualPending === null && state.autoRun.turnIds.includes(e.turnId)) {
    return {
      state: { ...state, manualPending: { path: e.path, turnId: e.turnId, markers: e.markers } },
      effects: [logEffect('auto-queued', `${state.cycleId} ${e.path} for the end of run turn ${e.turnId}`)],
    }
  }
  if (state.phase !== 'IDLE') {
    return { state, effects: [logEffect('manual-refused', `${e.path} while ${state.cycleId ?? '-'} is in ${state.phase}`)] }
  }
  return {
    state: { ...state, manualPending: { path: e.path, turnId: e.turnId, markers: e.markers } },
    effects: [logEffect('manual-queued', `${e.path} for the end of turn ${e.turnId}`)],
  }
}

/** The end of the turn that queued a manual brief: GRACE with that brief, or a notice saying why not. */
function startManual(state: MachineState, e: EventOf<'turnEnd'>, config: HandoffConfig): Step {
  const pending = state.manualPending as NonNullable<MachineState['manualPending']>
  const cleared = { ...state, manualPending: null }
  const why =
    e.turnId !== pending.turnId ? `turn ${e.turnId ?? '?'} ended instead of the turn that asked for it (${pending.turnId})`
      : e.reason !== 'answer' ? `the turn ended with ${e.reason}`
        : guardManual(state, e)
  if (why !== null) {
    return {
      state: cleared,
      effects: [
        logEffect('manual-skip', `${pending.path}: ${why}`),
        { type: 'pinNotice', text: `context-handoff: handoff not run: ${why}. The brief is ${pending.path}` },
      ],
    }
  }
  const cycleSeq = state.cycleSeq + 1
  const cycleId = `${state.sessionId}#${cycleSeq}`
  const next: MachineState = {
    ...enter(cleared, 'GRACE', e.now, config.clearGraceSeconds * 1000),
    cycleSeq,
    cycleId,
    ...emptyCycle(),
    isManual: true,
    lastClearTimeout: null,
    briefPath: pending.path,
    verifiedCycleId: cycleId,
    markers: pending.markers,
    hasMarkerSnapshot: true,
    triggerTurnId: e.turnId ?? null,
  }
  return {
    state: next,
    effects: [
      logEffect('grace', `${cycleId} manual brief ${pending.path}, ${config.clearGraceSeconds}s`),
      { type: 'showGrace', cycleId, deadline: next.deadline as number },
    ],
  }
}

// ---- the automatic run -------------------------------------------------------

/** The run event for this cycle in BRIEFING, or null (a late or foreign event is dropped). */
function currentRun(state: MachineState, e: CycleEvent): AutoRun | null {
  return state.phase === 'BRIEFING' && state.cycleId === e.cycleId ? state.autoRun : null
}

/**
 * The deferred auto-run guard (register.tsx startAutoRun, after autoRunCalled is dispatched): true
 * when this cycle is still in BRIEFING with its run marked called, so command.run may be issued.
 */
export function isRunCallable(state: MachineState, cycleId: string): boolean {
  const run = state.phase === 'BRIEFING' && state.cycleId === cycleId ? state.autoRun : null
  return run !== null && run.calledAt !== null
}

function onAutoRunCalled(state: MachineState, e: EventOf<'autoRunCalled'>, config: HandoffConfig): Step {
  const run = currentRun(state, e)
  if (run === null || run.calledAt !== null) return noop(state)
  return { state: { ...state, autoRun: { ...run, calledAt: e.now }, deadline: e.now + config.autoRunTimeoutSeconds * 1000 }, effects: [] }
}

function onAutoRunSubmit(state: MachineState, e: EventOf<'autoRunSubmit'>): Step {
  const run = currentRun(state, e)
  if (run === null || run.calledAt === null) return noop(state)
  return { state: { ...state, autoRun: { ...run, isSubmitSeen: true } }, effects: [] }
}

const COMMAND_ARGS_RE = /<command-args>([^<]*)<\/command-args>/g

/**
 * True when the turn.start markup is our skill's and its single `<command-args>` element equals
 * exactly `automatic-run cycle=<armed cycle> session=<this session>`.
 */
export function isOwnRunMarkup(text: string, cycleId: string, sessionId: string): boolean {
  if (!text.includes(AUTO_RUN_MARKUP)) return false
  const args = [...text.matchAll(COMMAND_ARGS_RE)].map(m => m[1])
  return args.length === 1 && args[0] === `automatic-run cycle=${cycleId} session=${sessionId}`
}

/**
 * Binding (live facts): the run's turn is the first main turn after auto-run-called whose markup
 * args name exactly the armed cycle and this session, announced by the own prompt.submit (origin
 * own-skill) or, without one, of origin other (the no-submit fallback). Anything else does not
 * consume the arm. After a run turn ended without a brief, only a prompt-less Stop-gate re-prompt
 * continues the run: empty turn.start text and no pending prompt of any origin.
 */
function bindRunTurn(state: MachineState, e: EventOf<'turnStart'>, config: HandoffConfig): Step {
  const run = state.autoRun as AutoRun
  if (e.turnId === undefined || e.origin === 'composer') return noop(state)
  const isOwnMarkup = isOwnRunMarkup(e.text ?? '', state.cycleId as string, state.sessionId)
  const isFirst = run.turnIds.length === 0 && run.calledAt !== null && isOwnMarkup && (e.origin === 'own-skill' || (!run.isSubmitSeen && e.origin === 'other'))
  const isPromptless = (e.text ?? '') === '' && e.isPrompted === false
  const isContinuation = run.isWaiting && run.isStopBlocked && isPromptless
  if (!isFirst && !isContinuation) {
    return { state, effects: [logEffect('auto-run-skip-turn', `${state.cycleId} turn ${e.turnId} origin=${e.origin} markup=${isOwnMarkup}: not the run`)] }
  }
  // A continuation gets the rest of the run's own deadline back (the wait had shortened it).
  const deadline = isContinuation ? (run.calledAt as number) + config.autoRunTimeoutSeconds * 1000 : state.deadline
  return {
    state: { ...state, autoRun: { ...run, turnIds: [...run.turnIds, e.turnId], isWaiting: false, isStopBlocked: false }, deadline },
    effects: [logEffect('auto-run-bound', `${state.cycleId} turn ${e.turnId} (${isContinuation ? 'continuation' : e.origin})`)],
  }
}

function onAutoRunFailed(state: MachineState, e: EventOf<'autoRunFailed'>): Step {
  if (currentRun(state, e) === null) return noop(state)
  return abort(state, e.now, 'auto-run-failed', e.failure)
}

/** The deadline of BRIEFING, by what the run reached. */
function autoRunTimeout(s: MachineState, now: number): Step {
  const run = s.autoRun
  const why =
    run === null || run.calledAt === null ? 'command.run never called'
      : run.turnIds.length === 0 ? 'no run turn started (the arm expired)'
        : run.isWaiting ? 'the run turn ended without handoff_now and no continuation followed'
          : 'the run did not hand off within autoRunTimeoutSeconds'
  return abort(s, now, 'auto-run-timeout', why)
}

// ---- cycle results -----------------------------------------------------------

/**
 * The common gate of a cycle result: another cycle's result is dropped, a
 * result in the wrong phase is logged and ignored, and a result that arrives
 * after the phase deadline takes the timeout path (as if the watchdog had run).
 */
function gateResult(state: MachineState, e: MachineEvent & CycleEvent, phase: Phase, config: HandoffConfig): Step | null {
  if (e.cycleId !== state.cycleId) {
    return { state, effects: [logEffect('stale-dropped', `${e.type} for ${e.cycleId}; current ${state.cycleId ?? 'none'}`)] }
  }
  if (state.phase !== phase) return { state, effects: [logEffect('out-of-order', `${e.type} in ${state.phase}`)] }
  if (isPastDeadline(state, e.now)) return timeoutStep(state, e.now, config)
  return null
}

function onClearResult(state: MachineState, e: EventOf<'clearResult'>, config: HandoffConfig): Step {
  if (e.cycleId !== state.cycleId) return gateResult(state, e, state.phase, config) as Step
  if (state.phase !== 'CLEARING') {
    const event = e.failure === undefined ? 'clear-accepted' : 'clear-rejected'
    return { state, effects: [logEffect(event, `${e.cycleId} after ${state.phase}${e.failure ? `: ${e.failure}` : ''}`)] }
  }
  const gated = gateResult(state, e, 'CLEARING', config)
  if (gated) return gated
  if (e.failure === undefined) return {
    state,
    effects: [
      logEffect('clear-accepted', e.cycleId),
      { type: 'pollNewId', cycleId: e.cycleId, oldSessionId: state.clearingFrom as string, withinMs: TIMEOUTS_MS.newIdPoll },
    ],
  }
  const reset = abort(state, e.now, 'clear-rejected', e.failure, clearByHandNotice(state))
  return { state: { ...reset.state, lastClearTimeout: clearTimeoutOf(state, e.now) }, effects: reset.effects }
}

function onNewIdResolved(state: MachineState, e: EventOf<'newIdResolved'>, config: HandoffConfig): Step {
  const gated = gateResult(state, e, 'CLEARING', config)
  if (gated) return gated
  if (e.failure !== undefined) {
    const reset = abort(state, e.now, 'new-id-missing', `session id probe failed: ${e.failure}`, briefNotice(state, 'could not see the new session id'))
    return { ...reset, state: { ...reset.state, lastClearTimeout: clearTimeoutOf(state, e.now) } }
  }
  if (e.sessionId === null || e.sessionId === state.clearingFrom) {
    const reset = abort(state, e.now, 'new-id-missing', `session id unchanged after ${TIMEOUTS_MS.newIdPoll / 1000} s`, briefNotice(state, 'could not see the new session id'))
    return { ...reset, state: { ...reset.state, lastClearTimeout: clearTimeoutOf(state, e.now) } }
  }
  return startCarrying(state, e.now, e.sessionId, 'session.id poll')
}

function onCarryDone(state: MachineState, e: EventOf<'carryDone'>, config: HandoffConfig): Step {
  // TRACK-23: an unapproved /retro latch that did not reach the new session id holds the seed, so
  // the new session does not continue as if no approval were pending. Checked before gateResult so
  // a failure reported at or past the deadline is not turned into the timeout path's seed; the cycle
  // and phase checks still apply.
  if (e.retroFailure !== undefined && e.cycleId === state.cycleId && state.phase === 'CARRYING') {
    return abort(state, e.now, 'retro-latch-failed', e.retroFailure,
      briefNotice(state, `retro latch not carried (${e.retroFailure}); continuation held, approve or close the /retro by hand`))
  }
  const gated = gateResult(state, e, 'CARRYING', config)
  if (gated) return gated
  const seeding = startSeeding(state, e.now, config)
  if (e.failure === undefined) return seeding
  return {
    state: seeding.state,
    effects: [
      logEffect('carry-failed', `${state.cycleId} ${e.failure}`),
      { type: 'pinNotice', text: `context-handoff: project markers not carried (${e.failure})` },
      ...seeding.effects,
    ],
  }
}

/** A rejected seed submit for this cycle: the fill fallback the seed timeout would reach, now. */
function onSeedFailed(state: MachineState, e: EventOf<'seedFailed'>): Step {
  if (state.phase !== 'SEEDING' || e.cycleId !== state.cycleId) return noop(state)
  return strandSeed(state, e.now, `seed submit failed: ${e.failure}`)
}

function onSeedUnknown(state: MachineState, e: EventOf<'seedUnknown'>): Step {
  if (state.phase !== 'SEEDING' || e.cycleId !== state.cycleId) return noop(state)
  return abort(state, e.now, 'seed-delivery-unknown', e.failure, briefNotice(state, 'seed delivery is unknown; check the new session before retrying'))
}

function onTrackRestoreFailed(state: MachineState, e: EventOf<'trackRestoreFailed'>): Step {
  if (state.phase !== 'SEEDING' || e.cycleId !== state.cycleId) return noop(state)
  return abort(state, e.now, 'track-restore-failed', e.failure, briefNotice(state, `Track restoration held continuation: ${e.failure}`))
}

function onSeedDelivered(state: MachineState, e: EventOf<'seedDelivered'>, config: HandoffConfig): Step {
  if (state.phase !== 'SEEDING') return noop(state)
  const gated = e.cycleId === state.cycleId ? null : gateResult(state, e, 'SEEDING', config)
  if (gated) return gated
  return { state: toIdle(state, e.now), effects: [logEffect('handoff-done', `${state.cycleId} seed delivered`)] }
}

// ---- the clear and after -----------------------------------------------------

function startClearing(state: MachineState, now: number): Step {
  return {
    state: { ...enter(state, 'CLEARING', now, TIMEOUTS_MS.clear), clearingFrom: state.sessionId },
    effects: [
      { type: 'hideBand' },
      logEffect('clearing', `${state.cycleId} from ${state.sessionId}`),
      { type: 'runClear', cycleId: state.cycleId as string },
    ],
  }
}

function startCarrying(state: MachineState, now: number, newId: string, source: string): Step {
  const oldId = state.clearingFrom as string
  const next: MachineState = {
    ...enter(state, 'CARRYING', now, TIMEOUTS_MS.carry),
    sessionId: newId,
    previousSessionId: oldId,
    responseReplay: state.lastResponse === null ? null : {
      cycleId: state.cycleId as string, destinationSession: newId,
      response: state.lastResponse, status: 'pending', uuid: null,
    },
    autoChain: state.autoChain + 1,
    baseTokens: null,
    // A fresh session: no inherited backoff or failure count.
    backoffTokens: null,
    backoffKind: null,
    failedCycles: 0,
    unclearedRuns: 0,
    lastTokens: null,
    backgroundTasks: 0,
    sessionCrons: 0,
    transcriptPath: null,
    lastClearTimeout: null,
  }
  return {
    state: next,
    effects: [
      logEffect('carrying', `${state.cycleId} ${oldId} -> ${newId} (id from ${source})`),
      { type: 'carryMarkers', cycleId: state.cycleId as string, fromSessionId: oldId, toSessionId: newId, snapshot: state.markers },
    ],
  }
}

function startSeeding(state: MachineState, now: number, config: HandoffConfig): Step {
  if (state.isSuperseded) {
    return {
      state: toIdle(state, now),
      effects: [logEffect('seed-superseded', `${state.cycleId} the user typed after the clear`), ...briefNotice(state, 'handoff done')],
    }
  }
  const via = config.seedVia
  const timeout = via === 'initial' ? TIMEOUTS_MS.seedInitialFallback : TIMEOUTS_MS.seed
  return {
    state: { ...enter(state, 'SEEDING', now, timeout), seedVia: via, isSeedFallbackUsed: false },
    effects: [
      logEffect('seeding', `${state.cycleId} via ${via}`),
      { type: 'submitSeed', cycleId: state.cycleId as string, briefPath: state.briefPath as string, via },
    ],
  }
}

/** The seed did not run: put it in the prompt box and pin a notice, so one Enter recovers. */
function strandSeed(state: MachineState, now: number, why: string): Step {
  const path = state.briefPath as string
  return {
    state: toIdle(state, now),
    effects: [
      logEffect('seed-stranded', `${state.cycleId} ${why}; filled the prompt box`),
      { type: 'fillSeed', briefPath: path },
      { type: 'pinNotice', text: `context-handoff: press Enter to start from the brief ${path}`, ifUnfilled: unfilledNotice(path) },
    ],
  }
}

/** The notice when the prompt box could not be filled: nothing waits there, so no "press Enter". */
function unfilledNotice(path: string): string {
  return `context-handoff: the prompt box could not be filled; ask to continue from the brief ${path}`
}

// ---- session identity --------------------------------------------------------

/** A new conversation that is not the machine's own handoff target: forget the old session's facts. */
function rebase(state: MachineState, newId: string, now: number, source: string): Step {
  const late = state.lastClearTimeout
  // Only a clear of the very session whose clear failed: never across a later handoff or another session.
  const isLateClear = source === 'clear' && late !== null && late.sessionId === state.sessionId && now - late.at <= TIMEOUTS_MS.lateClear
  const effects: Effect[] = [logEffect('session-change', `${state.sessionId} -> ${newId} (${source})`)]
  if (isLateClear && late.retro !== undefined && late.retro !== null && needsRetroCarry(late.retro)) {
    // TRACK-23 v3 (E4): the cleared session had an unapproved /retro latch. Carry it to the new id and
    // do not fill the seed, so the new session does not continue as if no approval were pending.
    effects.push({ type: 'carryRetroLatch', fromSessionId: late.sessionId, toSessionId: newId, retro: late.retro, briefPath: late.briefPath })
  } else if (isLateClear && late.briefPath !== null) {
    effects.push(
      { type: 'fillSeed', briefPath: late.briefPath },
      { type: 'pinNotice', text: `context-handoff: press Enter to start from the brief ${late.briefPath}`, ifUnfilled: unfilledNotice(late.briefPath) },
    )
  }
  return {
    state: {
      ...state,
      sessionId: newId,
      previousSessionId: null,
      lastResponse: null,
      responseReplay: null,
      baseTokens: null,
      autoChain: 0,
      backoffTokens: null,
      backoffKind: null,
      failedCycles: 0,
      unclearedRuns: 0,
      lastTokens: null,
      transcriptPath: null,
      backgroundTasks: 0,
      runningSubagents: 0,
      nudge: null,
      sessionCrons: 0,
      lastClearTimeout: null,
      manualPending: null,
    },
    effects,
  }
}

/** Sources that mean "our /clear landed" when seen in the machine's own CLEARING. */
const CLEAR_SOURCES: readonly string[] = ['clear', 'turn-end']

/**
 * The process is now in session `newId`. In the machine's own CLEARING (and
 * in time) that is the handoff target; anywhere else it aborts the cycle and
 * rebases on the new session.
 */
function changeSession(state: MachineState, newId: string, now: number, source: string, config: HandoffConfig): Step {
  if (newId === state.sessionId) return noop(state)
  if (state.phase === 'CLEARING' && isPastDeadline(state, now)) {
    const timedOut = timeoutStep(state, now, config)
    const after = changeSession(timedOut.state, newId, now, source, config)
    return { state: after.state, effects: [...timedOut.effects, ...after.effects] }
  }
  if (state.phase === 'CLEARING' && CLEAR_SOURCES.includes(source)) return startCarrying(state, now, newId, source)
  let ended: Step = noop(state)
  if (CANCELLABLE_PHASES.includes(state.phase)) ended = abort(state, now, 'cancelled', 'session-change')
  else if (state.phase === 'CLEARING') ended = abort(state, now, 'clear-abandoned', `session changed (${source})`)
  else if (state.phase === 'CARRYING' || state.phase === 'SEEDING') {
    ended = abort(state, now, 'seed-abandoned', `session changed again (${source})`, briefNotice(state, 'handoff interrupted'))
  }
  const rebased = rebase(ended.state, newId, now, source)
  return { state: rebased.state, effects: [...ended.effects, ...rebased.effects] }
}

function onSessionStart(state: MachineState, e: EventOf<'sessionStart'>, config: HandoffConfig): Step {
  const isOwnClear = state.phase === 'CLEARING' && e.source === 'clear' && !isPastDeadline(state, e.now)
  if (isOwnClear && e.sessionId === state.clearingFrom) {
    return {
      state,
      effects: [
        logEffect('new-id-poll', `${state.cycleId} SessionStart carried the old id ${e.sessionId}`),
        { type: 'pollNewId', cycleId: state.cycleId as string, oldSessionId: e.sessionId, withinMs: TIMEOUTS_MS.newIdPoll },
      ],
    }
  }
  return changeSession(state, e.sessionId, e.now, e.source, config)
}

function onSessionEnd(state: MachineState, e: EventOf<'sessionEnd'>): Step {
  if (state.phase === 'CLEARING' && e.reason === 'clear') {
    return { state, effects: [logEffect('session-end', `${state.cycleId} clear accepted for ${state.sessionId}`)] }
  }
  if (CANCELLABLE_PHASES.includes(state.phase)) return abort(state, e.now, 'cancelled', `session-end (${e.reason})`)
  if (state.phase === 'CLEARING') return abort(state, e.now, 'clear-abandoned', `session-end (${e.reason})`)
  if (state.phase === 'CARRYING' || state.phase === 'SEEDING') {
    // The own clear's SessionEnd can be processed after its SessionStart: not a reason to drop the seed.
    if (e.reason === 'clear') return { state, effects: [logEffect('session-end', `${state.cycleId} late clear end in ${state.phase}; kept`)] }
    return abort(state, e.now, 'seed-abandoned', `session-end (${e.reason})`)
  }
  return noop(state)
}

// ---- user and other turns ----------------------------------------------------

function cancelIfPending(state: MachineState, now: number, reason: CancelReason, detail = ''): Step {
  if (!CANCELLABLE_PHASES.includes(state.phase)) return noop(state)
  return abort(state, now, 'cancelled', `${reason}${detail}`, [], cancelKind(reason))
}

/** A typed prompt lifts a cancel backoff only; a failure backoff waits for growth. */
function liftCancelBackoff(state: MachineState): MachineState {
  return state.backoffKind === 'cancel' ? { ...state, backoffTokens: null, backoffKind: null } : state
}

function onTypedPrompt(state: MachineState, e: EventOf<'typedPrompt'>): Step {
  // A typed prompt resets the auto chain and lifts a cancel backoff, including the one its own cancel sets.
  const reset = liftCancelBackoff({ ...state, autoChain: 0, manualPending: null })
  if (state.phase === 'BRIEFING' && state.autoRun?.isWaiting) {
    // The run already ended without handing off: a failed run, so typing cannot turn it into a free retry.
    const failed = abort(state, e.now, 'auto-run-failed', 'the run turn ended without handoff_now; the user typed')
    return { state: { ...failed.state, autoChain: 0 }, effects: failed.effects }
  }
  if (CANCELLABLE_PHASES.includes(state.phase)) {
    const cancelled = cancelIfPending(reset, e.now, 'typed-prompt')
    return { state: liftCancelBackoff(cancelled.state), effects: cancelled.effects }
  }
  if (state.phase === 'CLEARING' || state.phase === 'CARRYING') {
    return { state: { ...reset, isSuperseded: true }, effects: [logEffect('superseded', `${state.cycleId} typed prompt in ${state.phase}`)] }
  }
  if (state.phase === 'SEEDING') {
    return {
      state: toIdle(reset, e.now),
      effects: [logEffect('seed-superseded', `${state.cycleId} the user typed first`), ...briefNotice(state, 'handoff done')],
    }
  }
  return noop(reset)
}

function onTurnStart(state: MachineState, e: EventOf<'turnStart'>, config: HandoffConfig): Step {
  // In BRIEFING a turn either binds to the run or is left alone; it never cancels the run.
  if (state.phase === 'BRIEFING' && state.autoRun !== null) return bindRunTurn(state, e, config)
  if (e.origin !== 'other' && e.origin !== 'own-skill') return noop(state)
  return cancelIfPending(state, e.now, 'other-turn')
}

function onStop(state: MachineState, e: EventOf<'stop'>): Step {
  if (e.agentId !== undefined) return noop(state)
  const transcriptPath = e.transcriptPath ?? state.transcriptPath
  const s: MachineState = { ...state, backgroundTasks: e.backgroundTasks, runningSubagents: e.runningSubagents ?? 0, sessionCrons: e.sessionCrons, transcriptPath }
  const run = s.phase === 'BRIEFING' && !s.isManual ? s.autoRun : null
  if (run === null || run.calledAt !== null || !isBackgroundBusy(s)) return noop(s)
  // The turn-end tick ran before this Stop record (W2e r2): the clean gate read the previous turn's
  // background count. The command is not called yet, so step back: IDLE, no backoff, no failure and
  // no uncleared run (none started), and the nudge window kept so no second nudge is injected.
  const reason = backgroundBusyReason(s)
  return {
    state: { ...toIdle(s, s.enteredAt), nudge: { at: s.enteredAt, tokens: s.cycleStartTokens, turnEnds: 0 } },
    effects: [logEffect('cancelled', `${s.cycleId} BRIEFING: ${reason} reported before the run was called; no backoff`)],
  }
}

/**
 * Whether a transcript record of `sessionId` would change the state: only the current session's, and
 * only while no path is known. register.tsx asks this first, so a noop is never dispatched or persisted.
 */
export function acceptsTranscript(state: MachineState, sessionId: string): boolean {
  return sessionId === state.sessionId && state.transcriptPath === null
}

/**
 * Fills an unknown transcript path from a main hook input of the current session only (session_id
 * equals the machine's), so another session's path is never recorded; a known path is left to Stop.
 */
function onTranscriptSeen(state: MachineState, e: EventOf<'transcriptSeen'>): Step {
  if (!acceptsTranscript(state, e.sessionId)) return noop(state)
  return noop({ ...state, transcriptPath: e.transcriptPath })
}

// ---- watchdog ----------------------------------------------------------------

type TimeoutHandler = (state: MachineState, now: number, config: HandoffConfig) => Step

const TIMEOUT_HANDLERS: Record<Exclude<Phase, 'IDLE'>, TimeoutHandler> = {
  BRIEFING: autoRunTimeout,
  GRACE: (s, now) =>
    now - (s.deadline as number) > TIMEOUTS_MS.graceSlack
      ? abort(s, now, 'grace-missed', `tick ${now - (s.deadline as number)} ms past the countdown; not clearing unseen`)
      : startClearing(s, now),
  CLEARING: (s, now) => {
    const reset = abort(s, now, 'clear-timeout', 'no SessionStart(clear) seen', clearByHandNotice(s))
    return { state: { ...reset.state, lastClearTimeout: clearTimeoutOf(s, now) }, effects: reset.effects }
  },
  CARRYING: (s, now, config) => {
    // TRACK-23: no carryDone by the deadline, and the brief recorded an unapproved /retro latch: the
    // carry is unconfirmed, so hold the seed instead of continuing.
    if (needsRetroCarry(s.markers?.retro)) {
      return abort(s, now, 'retro-latch-timeout', 'retro latch carry not confirmed before the carry deadline',
        briefNotice(s, 'retro latch carry not confirmed; continuation held, approve or close the /retro by hand'))
    }
    const seeding = startSeeding(s, now, config)
    return {
      state: seeding.state,
      effects: [
        logEffect('carry-timeout', `${s.cycleId} markers not confirmed; continuing`),
        { type: 'pinNotice', text: 'context-handoff: project markers were not carried; run /start if needed' },
        ...seeding.effects,
      ],
    }
  },
  SEEDING: (s, now) => abort(s, now, 'seed-delivery-unknown', 'seed turn not seen within the timeout', briefNotice(s, 'seed delivery unknown; check the new session before retrying')),
}

function timeoutStep(state: MachineState, now: number, config: HandoffConfig): Step {
  if (state.phase === 'IDLE') return noop(state)
  return TIMEOUT_HANDLERS[state.phase](state, now, config)
}

/** The kill switch: pre-clear phases abort; after the clear nothing more is submitted. */
function killSwitchStep(state: MachineState, now: number): Step | null {
  if (CANCELLABLE_PHASES.includes(state.phase)) return cancelIfPending(state, now, 'kill-switch')
  if (state.phase === 'CARRYING') return strandSeed(state, now, 'kill switch on before seeding')
  if (state.phase === 'SEEDING') {
    // The seed is already queued (or handed to SessionStart); filling the box too would duplicate it.
    return abort(state, now, 'cancelled', 'kill-switch after the seed was sent', briefNotice(state, 'disabled during the handoff'))
  }
  return null
}

function onTick(state: MachineState, e: EventOf<'tick'>, config: HandoffConfig): Step {
  if (state.phase === 'IDLE') return noop(state)
  const killed = e.isKillSwitchOn ? killSwitchStep(state, e.now) : null
  if (killed) return killed
  return isPastDeadline(state, e.now) ? timeoutStep(state, e.now, config) : noop(state)
}

/**
 * A Plannotator review opened after the cycle started: the watchdog's check cancels in BRIEFING or
 * GRACE, and the check right before the clear command cancels in CLEARING (the clear is not issued).
 * Like any started run that does not clear, an automatic one counts as an uncleared run (A11).
 */
function onReviewOpen(state: MachineState, e: EventOf<'reviewOpen'>): Step {
  if (state.cycleId !== e.cycleId) return noop(state)
  const isLive = CANCELLABLE_PHASES.includes(state.phase) || (state.phase === 'CLEARING' && e.at === 'clear')
  if (!isLive) return noop(state)
  const notice = state.isManual ? briefNotice(state, 'handoff cancelled: a Plannotator review is open') : []
  return abort(state, e.now, 'cancelled', `plannotator-review-open (${e.count}) at ${e.at}`, notice, 'cancel')
}

// ---- dispatch ----------------------------------------------------------------

/** A settings Stop block during the run re-prompts the model: the run continues instead of ending. */
function onCancel(state: MachineState, e: EventOf<'cancel'>): Step {
  if ((e.reason === 'activity-unknown' || e.reason === 'activity-busy' || e.reason === 'pre-clear-guard' || e.reason === 'checkpoint-failed') && state.phase === 'CLEARING') return abort(state, e.now, e.reason, 'safety check failed before clear', briefNotice(state, 'context retained; clear was not issued'))
  if (state.phase === 'IDLE' && state.manualPending !== null) {
    return { state: { ...state, manualPending: null }, effects: [logEffect('manual-cancelled', `${state.manualPending.path} (${e.reason})`)] }
  }
  if (e.reason === 'stop-blocked' && state.phase === 'BRIEFING' && state.autoRun !== null) {
    return { state: { ...state, autoRun: { ...state.autoRun, isStopBlocked: true } }, effects: [logEffect('auto-run-stop-blocked', `${state.cycleId} a Stop hook re-prompts; the run continues`)] }
  }
  return cancelIfPending(state, e.now, e.reason)
}

type Handlers = { [T in MachineEvent['type']]: (state: MachineState, e: EventOf<T>, config: HandoffConfig) => Step }

const HANDLERS: Handlers = {
  turnEnd: onTurnEnd,
  responseCompleted: (state, e) => noop(rememberResponse(state, e)),
  responseReplayAttempt: onReplayAttempt,
  responseReplayReceipt: onReplayReceipt,
  stop: onStop,
  transcriptSeen: onTranscriptSeen,
  typedPrompt: onTypedPrompt,
  turnStart: onTurnStart,
  cancel: onCancel,
  manualBrief: onManualBrief,
  // A compaction shrinks the context: the nudge window closes, so the next crossing nudges again.
  // It also re-arms the caps and the backoff, after any cancel it causes, so the regrown context can hand off.
  compacted: (state, e) => {
    // Its own cancel may reach a cap; that notice would be false at once, so it is dropped.
    const CAP_OFF_WORDING = 'so automatic handoff is off until the next compaction or session'
    const cancelled = cancelIfPending({ ...state, nudge: null }, e.now, 'compacted', ` (${e.trigger})`)
    const effects = cancelled.effects.filter(x => !(x.type === 'pinNotice' && x.text.includes(CAP_OFF_WORDING)))
    return { state: { ...cancelled.state, failedCycles: 0, unclearedRuns: 0, backoffTokens: null, backoffKind: null, lastTokens: null }, effects }
  },
  contextMeasured: onContextMeasured,
  compactRequested: onCompactRequested,
  sessionEnd: onSessionEnd,
  sessionStart: onSessionStart,
  autoRunCalled: onAutoRunCalled,
  autoRunSubmit: onAutoRunSubmit,
  autoRunFailed: onAutoRunFailed,
  clearResult: onClearResult,
  newIdResolved: onNewIdResolved,
  carryDone: onCarryDone,
  seedDelivered: onSeedDelivered,
  seedFailed: onSeedFailed,
  seedUnknown: onSeedUnknown,
  trackRestoreFailed: onTrackRestoreFailed,
  tick: onTick,
  reviewOpen: onReviewOpen,
}

/** Applies one event. Pure: the same state, event and config give the same step. */
export function step(state: MachineState, e: MachineEvent, config: HandoffConfig): Step {
  const handler = HANDLERS[e.type] as (state: MachineState, e: MachineEvent, config: HandoffConfig) => Step
  return handler(state, e, config)
}

// ---- queries -----------------------------------------------------------------

/**
 * Whether Track's waiting rows can change this turn end, so register.tsx asks Track first: the
 * machine's own step, dry-run with no waiting row and with Track absent, after the same session
 * change, compaction inference and measurement the real step applies. Only a 👉 hold or the
 * decision limit tells them apart.
 */
export function needsDecisionCheck(state: MachineState, e: EventOf<'turnEnd'>, config: HandoffConfig): boolean {
  const unregistered = step(state, { ...e, waitingRows: 0 }, config)
  const absent = step(state, { ...e, waitingRows: 'absent' }, config)
  return JSON.stringify(unregistered) !== JSON.stringify(absent)
}

/** Whether `turnId` is a turn of the automatic run in flight: the armed door and the allowlist ask this. */
export function isAutoRunTurn(state: MachineState, turnId: string): boolean {
  return state.phase === 'BRIEFING' && state.autoRun !== null && state.autoRun.turnIds.includes(turnId)
}

/** Whether a compaction must be skipped: only in GRACE/CLEARING with this cycle's verified brief. */
export function shouldVetoCompaction(state: MachineState, trigger: string, agentId: string | undefined): boolean {
  if (agentId !== undefined) return false
  if (!VETOED_TRIGGERS.includes(trigger)) return false
  if (!VETO_PHASES.includes(state.phase)) return false
  return state.cycleId !== null && state.verifiedCycleId === state.cycleId && state.briefPath !== null
}

/**
 * After a hot reload (timers lost), the persisted state decides. Only a state
 * this process owns and whose deadline has not passed is resumed: CLEARING
 * whose session id changed resumes at CARRYING. CARRYING can offer a seed;
 * SEEDING keeps delivery unknown because a seed may already be queued.
 * Everything else resets to IDLE (an expired or
 * foreign CLEARING with a notice naming the brief).
 */
export function recoverAfterReload(persisted: MachineState, currentSessionId: string, ownerId: string, now: number): Step {
  if (persisted.phase === 'IDLE') return noop(persisted)
  const isOwnedAndFresh = persisted.ownerId === ownerId && !isPastDeadline(persisted, now)
  if (persisted.phase === 'CLEARING') {
    if (isOwnedAndFresh && persisted.clearingFrom !== null && currentSessionId !== persisted.clearingFrom) {
      const carried = startCarrying(persisted, now, currentSessionId, 'reload')
      return { state: carried.state, effects: [logEffect('reload-resume', `${persisted.cycleId} CLEARING -> CARRYING`), ...carried.effects] }
    }
    const why = isOwnedAndFresh ? 'id unchanged' : persisted.ownerId === ownerId ? 'expired' : 'another process'
    return abort(persisted, now, 'reload-reset', `CLEARING ${why}`, briefNotice(persisted, 'handoff reset after a reload; if this session cleared'))
  }
  if (persisted.phase === 'SEEDING' && isOwnedAndFresh && persisted.briefPath !== null) {
    return abort(persisted, now, 'seed-delivery-unknown', 'reload during SEEDING', briefNotice(persisted, 'seed delivery unknown; check the new session before retrying'))
  }
  if (persisted.phase === 'CARRYING' && isOwnedAndFresh && persisted.briefPath !== null) {
    return strandSeed(persisted, now, `reload during ${persisted.phase}`)
  }
  return abort(persisted, now, 'reload-reset', 'state reset after reload')
}

/**
 * The armed window to rebuild after a hot reload, from the persisted state: the bound run turn ids
 * of a BRIEFING run whose skill was called ([] when the run turn id is unknown), else null. The
 * machine itself resets that run (recoverAfterReload), so the door stays closed; only the
 * allowlist is kept until the in-flight turn ends.
 */
export function reloadWindowOf(persisted: MachineState): string[] | null {
  const run = persisted.autoRun
  if (persisted.phase !== 'BRIEFING' || run === null || run.calledAt === null) return null
  return [...run.turnIds]
}
