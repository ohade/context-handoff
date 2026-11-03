// The handoff_now tool (W2-redesign P0; replaces compact_now, contract C4): gating and text. Pure.
// /compact-crafter ends with the session handed off through the mod's machine: no compaction.

import type { LastRunEnd, TurnOrigin } from './machine-types'

export const HANDOFF_NOW_NAME = 'handoff_now'
export const HANDOFF_NOW_REFUSAL =
  'handoff_now refused: only a turn the user started with /compact-crafter (or a typed handoff request), or the ' +
  "mod's own automatic run, may hand off. Tell the user the snapshot path and stop."
export const HANDOFF_NOW_QUEUED = 'handing off at the end of this turn'

export const HANDOFF_NOW_DESCRIPTION =
  'Hand this session off to a fresh session at the end of the current turn: the mod checks your snapshot ' +
  'against the compact-crafter template, adds the transcript facts, writes a verified brief, then clears ' +
  'and seeds the fresh session after a short cancellable countdown. Use it only when the user typed a ' +
  'handoff or compaction request in this turn (/compact-crafter, "hand off", "compact now"). ' +
  '`snapshot_path` is the snapshot file you wrote. A refusal means: show the user the snapshot path and ask. ' +
  'A "snapshot invalid: <reason>" answer means: fix the snapshot and call again in this turn.'

export const HANDOFF_NOW_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    snapshot_path: { type: 'string', description: 'Absolute path of the compact-crafter snapshot written in this turn.' },
  },
  required: ['snapshot_path'],
} as const

/** How the turn that calls the tool started (bound at turn.start, see API receipt G3). */
export type TurnInfo = {
  turnId: string
  origin: TurnOrigin
  /** The prompt text as submitted (prompt.submit). */
  promptText: string
  /** The text the turn proceeded with (turn.start). */
  turnText: string
}

/** The typed prompt without quoted material: fenced blocks, inline code and `>` quote lines. */
function ownWords(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n')
}

// Review ch L11 (2026-10-20): the second branch was unanchored, so any path containing
// /compact-crafter opened the door. It now needs a space or the start before the slash, and no path after it.
const SLASH_REQUEST_RE = /(^\s*\/compact(-crafter)?\b|(?:^|\s)\/(?:context-handoff:)?compact-crafter(?![\w/.-]))/i
const NEGATED_RE = /\b(don'?t|do not|no|never|not|stop|without|avoid|skip)[\s,.;:!-]+([\w']+[\s,]+){0,2}(\/?(?:context-handoff:)?compact(ion|ing|-crafter)?|hand[\s-]?off)\b/i
/**
 * What may follow the bare name, an allowlist: the end, a line break, sentence punctuation before a space, or one of a
 * few words that continue the instruction. Anything else ("compact-crafter tests", "compact-crafter.ts", "compact-crafter's",
 * "compact-crafter ./x", a lookalike dash) makes it a mention. Each allowed word has an opening test.
 */
const BARE_SKILL_TAIL =
  String.raw`(?:[ \t]+skill)?(?=[ \t]*(?:$|\r?\n)|[.,;:!)]+(?:\s|$)|[ \t]+(?:right[ \t]+now|now|just|then|first|please|pls|asap|again|immediately|thanks|and)\b(?!-))`
/** An instruction that names the skill without a slash: "do the compact-crafter", "run compact-crafter now", "do now the compact-crafter". */
const BARE_SKILL_RE = new RegExp(
  String.raw`\b(?:run|start|trigger|queue)\s+(?:a\s+|the\s+)?compact-crafter${BARE_SKILL_TAIL}|\bdo\s+(?:now\s+)?(?:the\s+|a\s+)?compact-crafter${BARE_SKILL_TAIL}`,
  'i',
)
const REQUEST_RES: readonly RegExp[] = [
  /(^|[.!?;,]\s*|\b(please|now|let'?s|go ahead and|prepare to|time to|ok(ay)?|then|and)\s+)compact\b/i,
  /\bcompact\s+(now|it|this|the|context|session)\b/i,
  /\b(run|start|do|trigger|queue)\s+(a\s+|the\s+)?compaction\b/i,
  /(^|[.!?;,]\s*|\b(please|now|let'?s|go ahead and|prepare to|time to|ok(ay)?|then|and)\s+)(hand\s+off|handoff)\b/i,
  /\b(hand\s+off|handoff)\s+(now|it|this|the|context|session)\b/i,
  /\b(run|start|do|trigger|queue)\s+(a\s+|the\s+)?hand-?off\b/i,
]

/**
 * A best-effort test for an explicit handoff or compaction request in the user's own words: a typed
 * `/compact-crafter` (anywhere) or a leading `/compact`, unless asked about in a question, or the
 * verb used as a request ("compact now", "please compact", "run a compaction", "do the compact-crafter").
 * Negations and quoted or fenced material are excluded, and so are questions for the slash and bare-name forms. It is a filter, not a proof: unquoted pasted text or an
 * unrelated "compact the JSON" can still pass, and a wrong open needs the model to call the tool
 * in a turn the user typed, then survives only until Cancel.
 */
export function isHandoffRequest(text: string): boolean {
  // A prompt that starts with the skill's command is the request, whatever follows it.
  if (/^\s*\/(?:context-handoff:)?compact-crafter\b/i.test(text)) return true
  const own = ownWords(text.replace(/[\u2018\u2019\u02BC]/g, "'"))
  if (NEGATED_RE.test(own)) return false
  // The slash form counts unless it is asked about ("/compact lost my hashes, why?").
  if (SLASH_REQUEST_RE.test(own) && !own.includes('?')) return true
  // The bare skill name counts only as an instruction, and not inside a question.
  if (!own.includes('?') && BARE_SKILL_RE.test(own)) return true
  return REQUEST_RES.some(re => re.test(own))
}

/**
 * Two doors, main loop only. Composer door: a turn the user started by typing a compaction request
 * (only the composer-typed prompt decides; the turn text never opens it). Armed door: a turn the
 * machine bound to the automatic run in flight (`isArmedTurn`, machine.isAutoRunTurn). A turn of a run that
 * has ended (`ended`, TRACK-25 U4) is answered with that ending before either door.
 */
/** TRACK-25 U4: the automatic run that owned the calling turn has ended; `seconds` is its timeout (autoRunTimeoutSeconds). */
export type RunEnded = { event: string; seconds: number }

/** The answer for a handoff_now call in a run turn after the run ended: the real reason, then the stop instruction. */
export function runEndedAnswer(ended: RunEnded): string {
  if (ended.event === 'auto-run-timeout') return `automatic run timed out after ${ended.seconds} s; stop and print one line`
  return `automatic run ended (${ended.event}); stop and print one line`
}

/** The ended run for the calling turn: only a turn of the recorded run, so an old ending never reaches a later turn. */
export function runEndedFor(end: LastRunEnd | null, turnId: string | null, seconds: number): RunEnded | undefined {
  if (end === null || turnId === null || !end.turnIds.includes(turnId)) return undefined
  return { event: end.event, seconds }
}

export function gateHandoffNow(turn: TurnInfo | null, agentId: string | undefined, isArmedTurn: boolean, ended?: RunEnded): { queue: 'manual' | 'auto' } | { refuse: string } {
  if (agentId !== undefined || turn === null) return { refuse: HANDOFF_NOW_REFUSAL }
  if (ended !== undefined) return { refuse: runEndedAnswer(ended) }
  if (isArmedTurn) return { queue: 'auto' }
  if (turn.origin !== 'composer' || !isHandoffRequest(turn.promptText)) return { refuse: HANDOFF_NOW_REFUSAL }
  return { queue: 'manual' }
}

const HEADER_SESSION_RE = /^session: (.*)$/m

/**
 * The armed door's extra check (CLAUDE_SESSION_ID is unset in the mod's env after /clear, so the
 * mod checks against its own $.session.id()): the snapshot lies directly under the brief folder,
 * its file name starts with the current full session id, and its header `session` is that id.
 * Returns the failure, or null.
 */
export function checkArmedSnapshot(path: string, text: string, briefDir: string, sessionId: string): string | null {
  return checkArmedPath(path, briefDir, sessionId) ?? checkArmedHeader(text, sessionId)
}

/** The armed door's path half, judged before the snapshot is opened: directly under the brief folder, named for this session. */
export function checkArmedPath(path: string, briefDir: string, sessionId: string): string | null {
  const name = path.slice(briefDir.length + 1)
  if (!path.startsWith(`${briefDir}/`) || name.includes('/') || name.includes('..')) return `snapshot must be directly under ${briefDir}`
  if (!name.startsWith(`${sessionId}-`)) return `the file name must start with the current session id ${sessionId}`
  return null
}

/** The armed door's content half: the header `session` is the current session id. */
function checkArmedHeader(text: string, sessionId: string): string | null {
  const header = HEADER_SESSION_RE.exec(text.split('\n').slice(0, 15).join('\n'))?.[1]?.trim()
  return header === sessionId ? null : `the header session ${header ?? '(none)'} is not the current session id ${sessionId}`
}

/** The skill's command: any typed prompt starting with it is the handoff itself, never the anchor. */
export const HANDOFF_COMMAND = '/context-handoff:compact-crafter'
export const LEGACY_HANDOFF_COMMAND = '/compact-crafter'

/** The gating prompt as the extractor compares it: trimmed, whitespace runs collapsed to one space. */
export function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The extractor call (C1). For a manual handoff it excludes the gating prompt (normalised) and any
 * prompt starting with /compact-crafter, so "Last user request" is the request before the handoff.
 */
export function extractorArgv(script: string, transcriptPath: string, gatingPrompt: string | null): string[] {
  const base = ['python3', script, transcriptPath, '--markdown', '--user-requests']
  if (gatingPrompt === null) return base
  return [...base, '--exclude-prompt', normalizePrompt(gatingPrompt), '--exclude-prefix', HANDOFF_COMMAND, '--exclude-prefix', LEGACY_HANDOFF_COMMAND]
}
