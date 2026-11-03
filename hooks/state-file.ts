// Encoding of the per-session state file (C5): one JSON file per session id
// under the state folder. Pure; register.tsx reads and writes through these.

import { initialState } from './machine'
import type { MachineState, Phase } from './machine'
import type { LastRunEnd, Nudge } from './machine-types'
import { completedResponseOf, responseReplayOf } from './response-replay'

const PHASES: readonly Phase[] = ['IDLE', 'BRIEFING', 'GRACE', 'CLEARING', 'CARRYING', 'SEEDING']
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** A number the guards can compute with: NaN and the infinities (a JSON 1e999) are not. */
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The file name for a session id, or null when the id could escape the folder. */
export function stateFileName(sessionId: string): string | null {
  return SAFE_ID.test(sessionId) ? `${sessionId}.json` : null
}

export function serializeState(state: MachineState): string {
  return `${JSON.stringify(state)}\n`
}

/**
 * Parses a persisted state file; null when it is not a version-1 machine
 * state. Fields a valid older file lacks take their initial values; a file
 * without an owner stamp reads as owned by nobody ('').
 */
export function parseState(text: string): MachineState | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null // A torn or foreign file is treated as absent; register logs it.
  }
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Partial<MachineState>
  if (s.version !== 1 || typeof s.sessionId !== 'string' || !PHASES.includes(s.phase as Phase)) return null
  if (typeof s.cycleSeq !== 'number' || typeof s.autoChain !== 'number' || typeof s.enteredAt !== 'number') return null
  if (s.ownerId !== undefined && typeof s.ownerId !== 'string') return null
  const merged = { ...initialState(s.sessionId, s.enteredAt, ''), ...s } as MachineState
  // Numbers the guards compute with: a corrupt value reads as absent, never as NaN.
  const num = (v: unknown) => (isFiniteNumber(v) ? v : null)
  return {
    ...merged,
    backoffTokens: num(merged.backoffTokens),
    cycleStartTokens: num(merged.cycleStartTokens),
    backoffKind: merged.backoffKind === 'cancel' || merged.backoffKind === 'not-now' || merged.backoffKind === 'failure' ? merged.backoffKind : null,
    failedCycles: num(merged.failedCycles) ?? 0,
    unclearedRuns: num(merged.unclearedRuns) ?? 0,
    lastTokens: num(merged.lastTokens),
    runningSubagents: num(merged.runningSubagents) ?? 0,
    nudge: parseNudge(merged.nudge),
    lastRunEnd: parseLastRunEnd(merged.lastRunEnd),
    lastResponse: completedResponseOf(merged.lastResponse),
    responseReplay: responseReplayOf(merged.responseReplay),
  }
}

/** The nudge window, or null when absent or malformed (the next crossing nudges again). */
function parseNudge(raw: unknown): Nudge | null {
  if (typeof raw !== 'object' || raw === null) return null
  const n = raw as Record<string, unknown>
  if (!isFiniteNumber(n.at) || !isFiniteNumber(n.turnEnds) || !(n.tokens === null || isFiniteNumber(n.tokens))) return null
  return { at: n.at, tokens: n.tokens, turnEnds: n.turnEnds }
}

/** The last run end (TRACK-25 U4), or null when absent (an older file) or malformed: never thrown. */
function parseLastRunEnd(raw: unknown): LastRunEnd | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const isTurnIds = Array.isArray(r.turnIds) && r.turnIds.every(id => typeof id === 'string')
  if (typeof r.cycleId !== 'string' || !isTurnIds || typeof r.event !== 'string' || !isFiniteNumber(r.at)) return null
  return { cycleId: r.cycleId, turnIds: [...(r.turnIds as string[])], event: r.event, at: r.at }
}
