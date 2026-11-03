// The ordinary-hook snapshot is authoritative only for the current activity generation.
// Release gate: classic hooks may be short-circuited by managed policy (2026-10-07).
import type { MachineEvent } from './machine-types'
import { stopRecord } from './turns'

export function readRelay(text: string | null, expected: { sessionId: string; owner: string; generation: string }): {
  transcriptPath: string | null
  stop: Extract<MachineEvent, { type: 'stop' }> | null
} {
  const unknown = { transcriptPath: null, stop: null }
  if (text === null || text.length > 1_048_576) return unknown
  try {
    const value = JSON.parse(text)
    if (value === null || value.v !== 1 || value.session_id !== expected.sessionId || !['SessionStart', 'Stop'].includes(value.event)) return unknown
    const transcriptPath = typeof value.transcript_path === 'string' && value.transcript_path.startsWith('/') && value.transcript_path.endsWith(`/${expected.sessionId}.jsonl`) ? value.transcript_path : null
    if (value.event !== 'Stop' || value.owner !== expected.owner || value.generation !== expected.generation || !Number.isFinite(value.observed_at)) return { transcriptPath, stop: null }
    const arraysValid = (array: unknown) => Array.isArray(array) && array.every(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    return {
      transcriptPath,
      stop: stopRecord({
        background_tasks: arraysValid(value.background_tasks) ? value.background_tasks : undefined,
        session_crons: arraysValid(value.session_crons) ? value.session_crons : undefined,
        ...(transcriptPath === null ? {} : { transcript_path: transcriptPath }),
      }) as Extract<MachineEvent, { type: 'stop' }>,
    }
  } catch {
    return unknown
  }
}
