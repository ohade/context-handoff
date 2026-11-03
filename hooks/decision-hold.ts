// TRACK-25 U2, pure parts: an open decision the person must answer (a line-start 👉) with no Track
// waiting row holds the automatic run for at most nudgeTurnLimit turn ends (machine.ts holds it);
// at that bound the run starts anyway and an unregistered item is kept as notes only.
import type { EventOf, MachineState } from './machine-types'
import type { PendingItem } from './pending-items'
import type { TrackCheckpoint } from './track-contract'

/** Track's waiting rows: a count, 'unknown' (no valid receipt) or 'absent' (no Track tools). */
export type WaitingRows = number | 'unknown' | 'absent'
export type DecisionHoldReason = 'decision-unregistered'
type TurnEnd = EventOf<'turnEnd'>

/** How a decision with no Track row is kept at the bound: section 3 and the seed note say this. */
export const NOTES_ONLY = 'no Track row; notes only'

/** A 👉 at a line start, after optional list or bold markup. */
const DECISION_LINE = /^[ \t]*(?:[-*]\s+)?\*{0,2}👉/m

export function hasDecisionLine(text: string): boolean {
  return DECISION_LINE.test(text)
}

/** The turn's answer, else the same session's last completed response. */
export function decisionText(state: MachineState, e: Pick<TurnEnd, 'answer' | 'sessionId'>): string {
  if (e.answer !== '') return e.answer
  return state.lastResponse !== null && state.lastResponse.sessionId === e.sessionId ? state.lastResponse.text : ''
}

/** 'decision-unregistered' when a 👉 decision has no confirmed waiting row; absent Track never holds. */
export function decisionHoldReason(state: MachineState, e: TurnEnd): DecisionHoldReason | null {
  if (e.waitingRows !== 0 && e.waitingRows !== 'unknown') return null
  return hasDecisionLine(decisionText(state, e)) ? 'decision-unregistered' : null
}

/** A checkpoint receipt's waiting rows; one with no open_steps inventory proves nothing. */
export function waitingRowsOf(checkpoint: TrackCheckpoint | null): WaitingRows {
  if (checkpoint === null) return 'absent'
  if (checkpoint.open_steps === undefined) return 'unknown'
  return checkpoint.open_steps.filter(step => step.status === 'waiting').length
}

/** The items that need exact Track coverage: past the decision bound, a null-track_id item is notes only. */
export function coveredItems(items: PendingItem[], isNotesOnly: boolean): PendingItem[] {
  return isNotesOnly ? items.filter(item => item.track_id !== null) : items
}
