// The machine's data: its state, the events it takes and the effects it returns.
// Pure types only; machine.ts holds the transitions.

import type { SeedVia } from './config'
import type { CompletedResponse, ResponseReplay } from './response-replay'
import type { RetroLatchSnapshot } from './retro-latch'

/** BRIEFING is the automatic run: the mod's own /compact-crafter turn writing the snapshot. */
export type Phase = 'IDLE' | 'BRIEFING' | 'GRACE' | 'CLEARING' | 'CARRYING' | 'SEEDING'

/** What register.tsx read from both project markers before the clear (markers.ts decides the carry). */
export type MarkerSnapshot = {
  project: string | null
  verified: string | null
  /** TRACK-23: the source session's /retro latch when the brief was queued (retro-latch.ts). */
  retro?: RetroLatchSnapshot | null
}

export type TurnEndReason = 'answer' | 'aborted' | 'refusal' | 'error'
/**
 * Who started a turn: a typed prompt, this mod's own seed, this mod's own automatic run of the skill
 * (its prompt.submit named the armed cycle), or anything else (cron, wake, another plugin).
 */
export type TurnOrigin = 'composer' | 'own-seed' | 'own-skill' | 'other'
export type CancelReason =
  | 'button' | 'typed-prompt' | 'other-turn' | 'compacted' | 'session-end' | 'session-change' | 'kill-switch'
  | 'stop-blocked' | 'persist-failed' | 'activity-unknown' | 'activity-busy' | 'pre-clear-guard' | 'checkpoint-failed'

/** The automatic run in BRIEFING: when the skill was called, and the turns bound to it. */
export type AutoRun = {
  /** When `$.command.run` was issued (auto-run-called); null until then. The run deadline counts from it. */
  calledAt: number | null
  /** The mod's own prompt.submit for this cycle was seen (live: it fires before the run's turn.start). */
  isSubmitSeen: boolean
  /** The run's turns: the bound skill turn, then any Stop-gate continuation. */
  turnIds: string[]
  /** A run turn ended without handoff_now; a continuation may still start within autoRunContinuation. */
  isWaiting: boolean
  /** A settings Stop hook blocked during the run: its re-prompt continues the run. */
  isStopBlocked: boolean
}

export type Nudge = { at: number; tokens: number | null; turnEnds: number }

/** How the last started automatic run ended (abort): its cycle, its turns, the abort event and when. */
export type LastRunEnd = { cycleId: string; turnIds: string[]; event: string; at: number }

export type MachineState = {
  version: 1
  phase: Phase
  /** The session the process is in now. */
  sessionId: string
  /** Per-process instance id stamped by register; reload recovery requires it to match. */
  ownerId: string
  /** Id of the module load that last wrote this state; a superseded load's writes are refused. */
  loadId: string
  cycleSeq: number
  /** The current attempt, `<sessionId>#<n>`; null in IDLE. */
  cycleId: string | null
  enteredAt: number
  deadline: number | null
  /** Handoffs run since the last typed prompt. */
  autoChain: number
  /** Context tokens at the first measured turn end of this session. */
  baseTokens: number | null
  /** The session this one was handed off from, or null. */
  previousSessionId: string | null
  /** Exact completed main response; helper turns never replace it. */
  lastResponse: CompletedResponse | null
  /** Retained after the cycle ends, so reload cannot repeat an uncertain display. */
  responseReplay: ResponseReplay | null
  /** From the last classic.Stop of this session (`background_tasks`, d.ts StopHookInput). */
  backgroundTasks: number | null
  /** Of those, the entries of type `subagent` (d.ts BackgroundTaskSummary.type). */
  runningSubagents: number
  /**
   * Stage 1 of the automatic path: the one nudge this window injected (at a main tool result at the
   * threshold), and the main turn ends since it. Null until then; a cycle start, a session change
   * or a compaction closes the window.
   */
  nudge: Nudge | null
  sessionCrons: number | null
  transcriptPath: string | null
  /**
   * Context tokens at the start of the last cycle that ended before a clear (failure, timeout or
   * cancel). No new cycle starts until the context grows by minGrowthTokens past it or the user
   * types: each automatic run is a full skill turn, so a failure must not repeat at every turn end.
   */
  backoffTokens: number | null
  /**
   * 'cancel' (typed prompt, other turn, compaction, session events): a typed prompt lifts it.
   * 'not-now' (the Cancel button) and 'failure': only growth lifts it. A compaction lifts every kind.
   */
  backoffKind: 'cancel' | 'not-now' | 'failure' | null
  /** Cycles that failed before or during the clear since the last compaction or session start; at the cap no new cycle starts. A compaction or a new session resets it. */
  failedCycles: number
  /** Automatic runs since the last compaction or session start that reached auto-run-called and ended without a clear (any reason); at UNCLEARED_RUN_CAP the automatic path is off. A compaction or a new session resets it. */
  unclearedRuns: number
  /** Context tokens at the last main turn end of this session, or null before the first. A drop of minGrowthTokens or more since then is a compaction the hooks did not report. */
  lastTokens: number | null
  /**
   * Set when CLEARING timed out, so a clear landing soon after still names the brief. `retro` (TRACK-23
   * v3, E4): the cycle's /retro latch, so that clear carries it instead of filling the seed.
   */
  lastClearTimeout: { briefPath: string | null; at: number; sessionId: string; retro?: RetroLatchSnapshot | null } | null
  // Cycle data (reset at IDLE).
  markers: MarkerSnapshot | null
  hasMarkerSnapshot: boolean
  briefPath: string | null
  /** The cycle whose brief passed verification; the veto needs it to equal cycleId. */
  verifiedCycleId: string | null
  /** The id being cleared (CLEARING onward). */
  clearingFrom: string | null
  /** The user typed after the clear was issued: pin the brief instead of seeding. */
  isSuperseded: boolean
  /** Context tokens at this cycle's turn end (the backoff base if the cycle fails). */
  cycleStartTokens: number | null
  /** The turn whose end started this cycle (or, from GRACE on, the run turn that made the brief). */
  triggerTurnId: string | null
  seedVia: SeedVia | null
  isSeedFallbackUsed: boolean
  /** A handoff the user asked for (handoff_now): its aborts never charge the failure cap or backoff. */
  isManual: boolean
  /** A verified brief waiting for the end of the turn that made it (manual, or the run's bound turn). */
  manualPending: { path: string; turnId: string; markers: MarkerSnapshot | null } | null
  autoRun: AutoRun | null
  /**
   * TRACK-25 U4: how the last started automatic run ended (abort). Kept after the cycle, so handoff_now in
   * one of its turns answers the real reason; register.tsx matches the turn id, so it never reaches a later run.
   */
  lastRunEnd: LastRunEnd | null
}

export type CycleEvent = { cycleId: string; now: number }

/** The measurements a cycle start is guarded on (a turn end, or an auto compaction). */
type Measured = {
  now: number
  sessionId: string
  percent?: number
  tokens?: number
  draft: string
  isKillSwitchOn: boolean
  /** Plannotator reviews open for this session (reviews.ts), or 'unknown' when the store could not be read. */
  openReviews: number | 'unknown'
}

export type MachineEvent =
  /** `isTypedPending`: a typed prompt was submitted over the ending turn, so it waits to start the next one. */
  | (Measured & { type: 'turnEnd'; turnId?: string; reason: TurnEndReason; agentId?: string; answer: string; isTypedPending?: boolean; isHandoffTurn?: boolean
    /** TRACK-25: Track's waiting rows when the answer holds a 👉 decision line; 'absent' = no Track, 'unknown' = no valid receipt. */
    waitingRows?: number | 'unknown' | 'absent'
    /** TRACK-25 (runtime-only, register.tsx): the nudge window (`nudge.at`) whose one re-arm was already delivered. */
    rearmedWindow?: number | null })
  /** Capture before the deferred activity check: that check may be superseded by another turn. */
  | { type: 'responseCompleted'; sessionId: string; turnId: string; answer: string; reason: TurnEndReason; isHandoffTurn: boolean }
  | ({ type: 'responseReplayAttempt'; destinationSession: string; attemptId: string } & CycleEvent)
  | ({ type: 'responseReplayReceipt'; destinationSession: string; attemptId: string; uuid: string | null } & CycleEvent)
  /** A main-loop tool result's context size (classic.PostToolUse): stage 1, the nudge. */
  | (Omit<Measured, 'draft'> & { type: 'contextMeasured'; agentId?: string })
  /** session.compact trigger auto (main agent): in IDLE with the guards passing it arms the run instead. */
  | (Measured & { type: 'compactRequested' })
  | { type: 'stop'; backgroundTasks: number | null; runningSubagents?: number; sessionCrons: number | null; transcriptPath: string | null; agentId?: string }
  /** A main hook input's transcript path (classic.PostToolUse / SessionStart), before the first Stop. */
  | { type: 'transcriptSeen'; sessionId: string; transcriptPath: string }
  | { type: 'typedPrompt'; now: number }
  /** `isPrompted`: a prompt of any origin was pending when the turn started (absent reads as prompted). */
  | { type: 'turnStart'; now: number; origin: TurnOrigin; turnId?: string; text?: string; isPrompted?: boolean }
  | { type: 'cancel'; now: number; reason: CancelReason }
  | { type: 'compacted'; now: number; trigger: string }
  /** handoff_now verified a brief from the skill's snapshot in turn `turnId`; consumed at that turn's end. */
  | { type: 'manualBrief'; now: number; path: string; turnId: string; markers: MarkerSnapshot | null }
  | { type: 'sessionEnd'; now: number; reason: string }
  | { type: 'sessionStart'; now: number; sessionId: string; source: string }
  | ({ type: 'autoRunCalled' } & CycleEvent)
  /** The mod's own prompt.submit carried `/compact-crafter automatic-run cycle=<cycleId> …`. */
  | ({ type: 'autoRunSubmit' } & CycleEvent)
  /** The run failed outside the machine's view: the call was rejected, or the tool cap was reached. */
  | ({ type: 'autoRunFailed'; failure: string } & CycleEvent)
  | ({ type: 'clearResult'; failure?: string } & CycleEvent)
  /** `failure`: the session id probe rejected (W8 B2); the cycle ends at once, as with no new id. */
  | ({ type: 'newIdResolved'; sessionId: string | null; failure?: string } & CycleEvent)
  | ({ type: 'carryDone'; failure?: string; retroFailure?: string } & CycleEvent)
  | ({ type: 'seedDelivered' } & CycleEvent)
  /** The seed submit was rejected: fall back to the prompt box now, not at the seed timeout. */
  | ({ type: 'seedFailed'; failure: string } & CycleEvent)
  /** Submission threw without a delivery receipt: retain the brief, never create a duplicate retry draft. */
  | ({ type: 'seedUnknown'; failure: string } & CycleEvent)
  | ({ type: 'trackRestoreFailed'; failure: string } & CycleEvent)
  | { type: 'tick'; now: number; isKillSwitchOn: boolean }
  /**
   * A Plannotator review is open after the cycle started: the watchdog's check (BRIEFING, GRACE) or
   * the check right before the clear command (CLEARING, clear not yet issued). Cancels the cycle.
   */
  | ({ type: 'reviewOpen'; count: number; at: 'watchdog' | 'clear' } & CycleEvent)

export type Effect =
  | { type: 'log'; event: string; detail: string }
  /**
   * Runs /compact-crafter through $.command.run, deferred: the skill turn writes the snapshot and calls handoff_now.
   * `decisionLimitReached` (TRACK-25, runtime-only): the decision hold hit its bound; null-track_id items are notes only.
   */
  | { type: 'startAutoRun'; cycleId: string; decisionLimitReached?: true }
  | { type: 'showGrace'; cycleId: string; deadline: number }
  | { type: 'hideBand' }
  | { type: 'runClear'; cycleId: string }
  | { type: 'pollNewId'; cycleId: string; oldSessionId: string; withinMs: number }
  | { type: 'carryMarkers'; cycleId: string; fromSessionId: string; toSessionId: string; snapshot: MarkerSnapshot | null }
  | { type: 'submitSeed'; cycleId: string; briefPath: string; via: SeedVia }
  | { type: 'fillSeed'; briefPath: string }
  /** TRACK-23 v3 (E4): a late clear carries the cleared session's unapproved /retro latch instead of filling the seed. */
  | { type: 'carryRetroLatch'; fromSessionId: string; toSessionId: string; retro: RetroLatchSnapshot; briefPath: string | null }
  /** `ifUnfilled` replaces `text` when the fillSeed before it in the same step could not fill the prompt box. */
  | { type: 'pinNotice'; text: string; ifUnfilled?: string }
  /**
   * The one nudge: register.tsx hands this text to the model with the tool result that measured it.
   * `rearmedWindow` (TRACK-25): a decision hold's re-arm, naming its window (`nudge.at`) so it happens once.
   */
  | { type: 'nudge'; text: string; rearmedWindow?: number }
  /**
   * TRACK-33: a turn end held by background work past the ceiling queues this line for the next main
   * tool result, only when no text waits there (a TRACK-25 re-arm is kept); it never sets the re-arm marker.
   */
  | { type: 'backgroundReminder'; text: string }
  /** Run the extractor in the background now (no model); the run's brief reuses it (nudge.ts). */
  | { type: 'precomputeFacts'; sessionId: string }
  /** A review held a nudged handoff past the ceiling or the turn limit: register.tsx pins one notice per session. */
  | { type: 'reviewHeld'; reason: string }

export type Step = { state: MachineState; effects: Effect[] }

export type EventOf<T extends MachineEvent['type']> = Extract<MachineEvent, { type: T }>
