// Who started a turn, and what a classic Stop means for the machine. Pure.
// tool.call carries no turn id or origin (API receipt G3), so prompt.submit
// and turn.start are bound here; a pending origin outlives at most one turn end, and only for its own turn.

import type { TurnInfo } from './handoff-now'
import { HANDOFF_COMMAND } from './handoff-now'
import type { MachineEvent, TurnOrigin } from './machine-types'

export type OriginLike = { kind: string; name?: string }

/** The prompt the mod's automatic run submits (live: its own prompt.submit hook sees exactly this). */
const AUTO_RUN_ARGS_RE = /^automatic-run cycle=(\S+) session=\S+/

/** The cycle named by an automatic-run prompt, or null for any other text. */
export function autoRunCycleOf(text: string): string | null {
  const prefix = `${HANDOFF_COMMAND} `
  return text.startsWith(prefix) ? AUTO_RUN_ARGS_RE.exec(text.slice(prefix.length))?.[1] ?? null : null
}

/**
 * The origin handoff_now and the machine's turnStart read. The mod's own prompt is `own-skill` only
 * when it names the cycle armed now (`armedCycle`), `own-seed` when it is not an automatic-run
 * prompt (the seed), and `other` for an automatic-run prompt of any other cycle.
 */
export function originOf(origin: OriginLike, pluginName: string, text = '', armedCycle: string | null = null): TurnOrigin {
  if (origin.kind === 'composer') return 'composer'
  if (origin.kind !== 'plugin' || origin.name !== pluginName) return 'other'
  const cycle = autoRunCycleOf(text)
  if (cycle === null) return 'own-seed'
  return cycle === armedCycle ? 'own-skill' : 'other'
}

/** A prompt from the person: typed at the terminal, or through Remote Control (bridge). */
/** CC-177: the exact doorbell line the AMQ wake injector types; anything else typed is the user. */
const AMQ_DOORBELL = ': AMQ doorbell run amq drain --include-body then act on it'

export function isAmqDoorbell(text: string): boolean {
  return text.trim() === AMQ_DOORBELL
}

export function isTypedPrompt(origin: OriginLike): boolean {
  return origin.kind === 'composer' || origin.kind === 'bridge'
}

const SLASH_PROMPT_RE = /^\/(\S+)(?:\s+([\s\S]*))?$/
/** One element of a slash command's turn markup; args may hold any character, `<` included. */
const COMMAND_ELEMENT_RE = /\s*(?:<command-message>[^<]*<\/command-message>|<command-name>([^<]*)<\/command-name>|<command-args>([\s\S]*?)<\/command-args>)/y

/**
 * The command a turn's text consists of: only command elements, exactly one `<command-name>` and at
 * most one `<command-args>`, nothing else before, between or after them. Null for any other text, so
 * a turn that merely quotes the markup (a task notification) is not a command turn.
 */
function commandOf(turn: string): { name: string; args: string } | null {
  const element = new RegExp(COMMAND_ELEMENT_RE)
  let name: string | null = null
  let args: string | null = null
  while (element.lastIndex < turn.length) {
    const m = element.exec(turn)
    if (m === null) return null
    if (m[1] !== undefined) {
      if (name !== null) return null
      name = m[1]
    } else if (m[2] !== undefined) {
      if (args !== null) return null
      args = m[2]
    }
  }
  return name === null ? null : { name, args: args ?? '' }
}

/**
 * True when a turn's text carries this prompt: equal once trimmed, or the prompt is `/<name>[ <args>]`
 * and the turn is that command's markup alone, named exactly `/<name>` with the same trimmed args (an
 * argless prompt only binds absent or empty args, so it never claims the automatic run's turn).
 * Empty turn text never matches.
 */
function isTurnOfPrompt(promptText: string, turnText: string): boolean {
  const prompt = promptText.trim()
  const turn = turnText.trim()
  if (turn === '') return false
  if (prompt === turn) return true
  const slash = SLASH_PROMPT_RE.exec(prompt)
  if (slash === null) return false
  const command = commandOf(turn)
  return command !== null && command.name === `/${slash[1] ?? ''}` && command.args.trim() === (slash[2] ?? '').trim()
}

export class TurnTracker {
  private pending: { origin: TurnOrigin; text: string; isCrossed: boolean } | null = null
  current: TurnInfo | null = null

  /** A prompt submitted while idle starts the next turn; one typed over a running turn (turnId set) does not. */
  onPromptSubmit(origin: TurnOrigin, text: string, turnId: string | undefined): void {
    if (turnId === undefined) this.pending = { origin, text, isCrossed: false }
  }

  /**
   * The new current turn; `isPrompted` says a prompt of any origin was pending (a continuation has none).
   * A prompt that crossed a turn end binds only the turn that carries its text; any other turn drops it.
   */
  onTurnStart(turnId: string, text: string): TurnInfo & { isPrompted: boolean } {
    const pending = this.pending !== null && (!this.pending.isCrossed || isTurnOfPrompt(this.pending.text, text)) ? this.pending : null
    this.pending = null
    this.current = { turnId, origin: pending?.origin ?? 'other', promptText: pending?.text ?? '', turnText: text }
    return { ...this.current, isPrompted: pending !== null }
  }

  /**
   * Ends the current turn. A prompt submitted as the previous turn was finishing survives one turn end,
   * marked crossed (live 2026-10-12: typed /compact-crafter started its turn as other); a second turn end
   * drops it, as does a turn that does not carry its text (a hook blocked it).
   */
  onTurnComplete(turnId: string): void {
    this.pending = this.pending === null || this.pending.isCrossed ? null : { ...this.pending, isCrossed: true }
    if (this.current?.turnId === turnId) this.current = null
  }
}

type StopInput = {
  agent_id?: string
  background_tasks?: readonly unknown[]
  session_crons?: readonly unknown[]
  transcript_path?: string
}

/**
 * The stop record for a main-loop classic.Stop. register.tsx dispatches it BEFORE the settings
 * Stop hooks run, so the background-task and cron guards see this turn's counts.
 */
export function stopRecord(input: StopInput): MachineEvent | null {
  if (input.agent_id !== undefined) return null
  // d.ts BackgroundTaskSummary.type: 'subagent' marks a running subagent among the background tasks.
  const subagents = (input.background_tasks ?? []).filter(t => (t as { type?: unknown } | null)?.type === 'subagent')
  return {
    type: 'stop',
    backgroundTasks: Array.isArray(input.background_tasks) ? input.background_tasks.length : null,
    runningSubagents: subagents.length,
    sessionCrons: Array.isArray(input.session_crons) ? input.session_crons.length : null,
    transcriptPath: input.transcript_path ?? null,
  }
}

type MainInput = { agent_id?: string; session_id?: string; transcript_path?: string }

/**
 * The transcript path from a main-session hook input that can arrive before the first Stop
 * (classic.PostToolUse, which carries the nudge; classic.SessionStart for clear/compact). Both
 * carry BaseHookInput's `session_id` and `transcript_path` (d.ts). Like stopRecord, a subagent
 * input (`agent_id` set) gives nothing; the machine records it only for its current session.
 */
export function transcriptRecord(input: MainInput): Extract<MachineEvent, { type: 'transcriptSeen' }> | null {
  if (input.agent_id !== undefined) return null
  if (typeof input.session_id !== 'string' || typeof input.transcript_path !== 'string' || input.transcript_path === '') return null
  return { type: 'transcriptSeen', sessionId: input.session_id, transcriptPath: input.transcript_path }
}

/**
 * The cancel for a settings Stop hook `block`, read AFTER `next(e)`: a block re-prompts the model,
 * which a running cycle would miss.
 */
export function stopBlockCancel(input: StopInput, result: { block?: string }, now: number): MachineEvent | null {
  if (input.agent_id !== undefined || result.block === undefined) return null
  return { type: 'cancel', now, reason: 'stop-blocked' }
}
