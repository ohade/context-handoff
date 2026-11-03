// TRACK-23, 2026-10-15: retain the final visible answer, then replay it once in
// the handoff destination. An attempted append without a receipt is uncertain.

export type CompletedResponse = { sessionId: string; turnId: string; text: string }
export type ResponseReplay = {
  cycleId: string
  destinationSession: string
  response: CompletedResponse
  status: 'pending' | 'attempted' | 'shown' | 'refused'
  uuid: string | null
  attemptId?: string
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

export function completedResponseOf(raw: unknown): CompletedResponse | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Partial<CompletedResponse>
  return nonempty(value.sessionId) && nonempty(value.turnId) && nonempty(value.text)
    ? { sessionId: value.sessionId, turnId: value.turnId, text: value.text } : null
}

export function responseReplayOf(raw: unknown): ResponseReplay | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Partial<ResponseReplay>
  const response = completedResponseOf(value.response)
  if (response === null || !nonempty(value.cycleId) || !nonempty(value.destinationSession)) return null
  if (!['pending', 'attempted', 'shown', 'refused'].includes(value.status ?? '')) return null
  if (value.status !== 'pending' && !nonempty(value.attemptId)) return null
  if (value.status === 'shown' ? !nonempty(value.uuid) : value.uuid !== null) return null
  return { cycleId: value.cycleId, destinationSession: value.destinationSession, response,
    status: value.status!, uuid: value.uuid!, ...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }) }
}

export function responseNotice(response: CompletedResponse): string {
  return `Previous session response:\n\n${response.text}`
}

export function responseRowId(attemptId: string): string {
  return `response-${attemptId}`
}

/** A rewritten or incomplete receipt cannot prove that the exact text was displayed. */
export function responseReceiptOf(raw: unknown, expected: string): { uuid: string } | { refused: string } | { unknown: string } {
  if (typeof raw !== 'object' || raw === null) return { unknown: 'missing append receipt' }
  const value = raw as { deny?: unknown; uuid?: unknown; message?: { type?: unknown; content?: unknown } }
  if (typeof value.deny === 'string') return { refused: value.deny }
  const blocks = value.message?.content
  if (!nonempty(value.uuid) || value.message?.type !== 'system' || !Array.isArray(blocks) || blocks.length !== 1 ||
    blocks[0]?.type !== 'text' || blocks[0]?.text !== expected) return { unknown: 'append receipt does not contain the exact response' }
  return { uuid: value.uuid }
}
