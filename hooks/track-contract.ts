// v1 local release contract: Track alone owns its ledger. Handoff accepts only
// supported tool receipts, with exact session and restored-value validation.
export type TrackCheckpoint = {
  v: 1
  ok: true
  source_session: string
  revision: number
  checksum: string
  counts: { questions: number; answers: number; steps: number }
  // Optional for old v1 receipts, required to certify declared pending coverage.
  open_steps?: Array<{ id: string; status: 'pending' | 'paused' | 'waiting' | 'in_progress'; subject: string; note?: string }>
}
export const CHECKPOINT_TOOL = 'mcp__track__checkpoint'
export const RESTORE_TOOL = 'mcp__track__restore_tracker'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
// TodoWrite suffixes are normalized titles and can contain ordinary spaces.
export const isTrackStepId = (value: unknown): value is string => typeof value === 'string' && /^(?:plan|task|todo|restored:task):(?=\S)[^\r\n]+$/.test(value)

function inventoryFailure(value: unknown, stepCount: number): string | null {
  if (!Array.isArray(value) || value.length > stepCount) return 'checkpoint open_steps inventory is invalid'
  const ids = new Set<string>()
  for (const raw of value) {
    const row = record(raw)
    if (row === null || !isTrackStepId(row.id) || typeof row.subject !== 'string' || row.subject.trim() === '' || !['pending', 'paused', 'waiting', 'in_progress'].includes(String(row.status)) || row.cleared === true || (Object.hasOwn(row, 'note') && typeof row.note !== 'string')) return 'checkpoint open_steps row is invalid'
    if (ids.has(row.id)) return 'checkpoint open_steps has duplicate ids'
    ids.add(row.id)
  }
  return null
}

function receiptOf(answer: unknown): RecordValue | { failure: string } {
  const call = record(answer)
  if (call === null) return { failure: 'no tool receipt' }
  if (typeof call.deny === 'string') return { failure: call.deny }
  if (call.isError === true) return { failure: typeof call.text === 'string' ? call.text : 'tool reported an error' }
  let text: unknown = call.result
  if (typeof text !== 'string') {
    const blocks = Array.isArray(text) ? text : record(text)?.content
    if (!Array.isArray(blocks) || blocks.length !== 1 || record(blocks[0])?.type !== 'text') return { failure: 'receipt must be one JSON text block' }
    text = record(blocks[0])?.text
  }
  if (typeof text !== 'string') return { failure: 'receipt must be JSON text' }
  try {
    const parsed = record(JSON.parse(text))
    return parsed ?? { failure: 'receipt must be a JSON object' }
  } catch {
    return { failure: 'receipt contains invalid JSON' }
  }
}

export function checkpointOf(answer: unknown, source: string): { checkpoint: TrackCheckpoint } | { failure: string } {
  const value = receiptOf(answer)
  if (typeof value.failure === 'string') return { failure: value.failure }
  if (value.v !== 1) return { failure: 'incompatible checkpoint version' }
  if (value.ok !== true) return { failure: typeof value.reason === 'string' ? value.reason : 'checkpoint was unsuccessful' }
  if (value.source_session !== source) return { failure: 'checkpoint source session does not match' }
  if (!integer(value.revision) || value.revision < 1 || typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(value.checksum)) return { failure: 'checkpoint revision or checksum is invalid' }
  const counts = record(value.counts)
  if (counts === null || !integer(counts.questions) || !integer(counts.answers) || !integer(counts.steps) || counts.answers > counts.questions) return { failure: 'checkpoint counts are invalid' }
  if (Object.hasOwn(value, 'open_steps')) {
    const failure = inventoryFailure(value.open_steps, counts.steps)
    if (failure !== null) return { failure }
  }
  return { checkpoint: value as TrackCheckpoint }
}

export function restorationOf(answer: unknown, checkpoint: TrackCheckpoint, destination: string): { restored: TrackCheckpoint & { destination_session: string; applied_checksum: string } } | { failure: string } {
  const parsed = checkpointOf(answer, checkpoint.source_session)
  if ('failure' in parsed) return parsed
  const value = parsed.checkpoint as TrackCheckpoint & { destination_session?: unknown; applied_checksum?: unknown }
  if (value.destination_session !== destination) return { failure: 'restore destination session does not match' }
  if (value.revision !== checkpoint.revision || value.checksum !== checkpoint.checksum || value.counts.questions !== checkpoint.counts.questions || value.counts.answers !== checkpoint.counts.answers || value.counts.steps !== checkpoint.counts.steps) return { failure: 'restored checkpoint does not match the requested values' }
  if (value.applied_checksum !== checkpoint.checksum) return { failure: 'actual restored values do not match the checkpoint' }
  return { restored: value as TrackCheckpoint & { destination_session: string; applied_checksum: string } }
}
