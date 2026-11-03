// The two-stage handoff, pure parts: the one nudge the model reads at the threshold, and when the
// extractor's background precompute is reused by the run's brief.

/**
 * Bound transcript growth while reusing precomputed facts. A turn can add a little
 * before it ends; more growth than this reruns the extractor.
 */
export const PRECOMPUTE_REUSE_BYTES = 256 * 1024

/** TRACK-25 U1: the ask rides the one nudge, while the model still has its turn to register the row. */
const NUDGE_ASK = 'Finish the step in progress, reach a natural checkpoint and stop; a context handoff will follow.' +
  ' If Track is available, before you stop, mark each open decision that waits on the person as a waiting step in Track, with its exact note; otherwise keep it in handoff notes.'

/** TRACK-33: a lead that keeps starting background work never reaches the clean turn end the run needs. */
const BACKGROUND_ASK = 'Start no new background work or subagents; let the running ones finish, then end the turn.'

/**
 * One line the model reads beside a tool result. It avoids every word the local prompt hooks route
 * on (tests/pure/seed-words.spec.ts lists them), so it asks for nothing beyond the stop.
 */
export function nudgeText(tokens: number | undefined, percent?: number): string {
  const size = tokens !== undefined && Number.isFinite(tokens) ? `${Math.round(tokens / 1000)}k tokens` : `${percent ?? '?'}% of the window`
  return `Context is at ${size}. ${NUDGE_ASK} ${BACKGROUND_ASK}`
}

/** The reminder line queued beside the next main tool result at each turn end held by background work past the ceiling. */
export function backgroundReminderText(): string {
  return `Context handoff is waiting for background work to finish. ${BACKGROUND_ASK}`
}

/** The pinned notice for that held end; `count` null is unknown activity, which holds the run too. */
export function backgroundHoldNotice(count: number | null): string {
  const holder = count === null ? 'background activity is unknown and holds' : `${count} background task(s) hold`
  return `context-handoff: ${holder} the handoff past the ceiling; it runs at the first turn end with none running. Start no new background work.`
}

/** The reminder rides only an empty slot: a queued TRACK-25 re-arm (or an earlier reminder) is kept as is. */
export function queueReminder(pending: string | null, reminder: string): string | null {
  return pending ?? reminder
}

export type TranscriptStat = { size: number; mtimeMs: number }
export type FactsKey = TranscriptStat & { sessionId: string }

/** Reuse the precomputed Facts, or say why they are rerun. */
export function decideFactsReuse(cache: FactsKey | null, sessionId: string, now: TranscriptStat): { isReused: true; grown: number } | { isReused: false; why: string } {
  if (cache === null) return { isReused: false, why: 'no precompute' }
  if (cache.sessionId !== sessionId) return { isReused: false, why: 'another session' }
  if (now.size < cache.size || now.mtimeMs < cache.mtimeMs) return { isReused: false, why: 'transcript rewritten' }
  const grown = now.size - cache.size
  if (grown >= PRECOMPUTE_REUSE_BYTES) return { isReused: false, why: `grew ${grown} bytes (bound ${PRECOMPUTE_REUSE_BYTES})` }
  return { isReused: true, grown }
}
