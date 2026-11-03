// The mod's own Track preparation step (handoff-gate contract r3, errata E-H1/E-H2). Track's Stop gate
// counts a step touched in the turn, so the run turn (automatic) or the handoff_now turn (manual) marks
// one step of its own. Pure: the hooks in register.tsx make the calls.

export const STEPS_TOOL = 'mcp__track__track_steps'
export const MARK_TOOL = 'mcp__track__mark_step'
export const PREPARATION_TOOLS: readonly string[] = [STEPS_TOOL, MARK_TOOL]

/**
 * One preparation per cycle (automatic, key = cycle id) or per handoff_now call (manual). `failed` is
 * terminal too: a failed creation is not retried for the same key (H5).
 */
export type Preparation = {
  route: 'auto' | 'manual'
  key: string
  turnId: string
  session: string
  stepId: string | null
  state: 'creating' | 'open' | 'terminal' | 'failed'
  failure: string | null
}

export const preparationTitle = (key: string): string => `context-handoff: prepare snapshot ${key}`

type ToolAnswer = { result?: unknown; deny?: string; isError?: boolean }

/** The answer's text, or the failure that refuses it. */
export function answerText(answer: ToolAnswer): { text: string } | { failure: string } {
  if (answer.deny !== undefined) return { failure: answer.deny }
  if (answer.isError === true) return { failure: `error: ${String(answer.result ?? '')}` }
  return { text: typeof answer.result === 'string' ? answer.result : JSON.stringify(answer.result ?? '') }
}

/** The id Track gave the step titled `title`, from track_steps' answer; null when it did not create it. */
export function createdStepId(text: string, title: string): string | null {
  if (!/^(?:Inserted after \S+|Tracking \d+ steps?): /.test(text)) return null
  const match = new RegExp(`(?:: |; )(plan:\\d+) ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:;|\\. Mark )`).exec(text)
  return match?.[1] ?? null
}

/** mark_step's success answer for exactly this id and status; live Track may append one matching `Saved row: {json}` line. */
export function isMarked(text: string, id: string, status: string): boolean {
  const [head = '', ...tail] = text.split('\n')
  const prefix = `Step ${id} "`
  const suffix = `" marked ${status}.`
  if (!head.startsWith(prefix) || !head.endsWith(suffix)) return false

  const subject = head.slice(prefix.length, head.length - suffix.length)
  if (subject.length === 0) return false
  if (tail.length === 0) return true
  if (tail.length !== 1 || !tail[0]?.startsWith('Saved row: ')) return false

  let row: unknown
  try {
    row = JSON.parse(tail[0].slice('Saved row: '.length))
  } catch {
    return false
  }

  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false
  const saved = row as Record<string, unknown>
  return saved.id === id && saved.subject === subject && saved.status === status
}

/** A call's arguments as the guard compares them: everything but the host-set fields, keys sorted. */
export function argumentsKey(call: Record<string, unknown>): string {
  const entries = Object.entries(call).filter(([key]) => key !== 'tool_use_id' && key !== 'agentId').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(entries)
}
