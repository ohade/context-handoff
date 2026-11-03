// The armed-window tool allowlist. Pure. Tripwire file: this is
// the automatic run's only barrier. While a turn of the run is current, every tool call is checked
// here: the run may only name its snapshot, write it, check it, find the transcript, and call
// handoff_now. Every Bash form is an exact anchored pattern with a safe charset per argument;
// `$`, backticks and `\` are refused anywhere first, because bash expands them inside double quotes.

export type RunContext = {
  /** The mod's own tool as the model calls it (mcp__context-handoff__handoff_now). */
  handoffTool: string
  /** The plugin root reported by the host; bundled skills are resolved only beneath it. */
  repoRoot: string
  home: string
  briefDir: string
  /** The current full session id ($.session.id()). */
  sessionId: string
  /** The session's transcript (.jsonl), or null when not yet known; Read may open it and its subagents folder. */
  transcriptPath: string | null
}

/**
 * Whether a tool call falls in the armed window: the current turn is a bound run turn, or a hot
 * reload rebuilt the window (`reloadWindow`, the persisted run turn ids) and the turn is the one in
 * flight across the reload (no current turn), one of those ids, or any turn when the ids are unknown.
 */
export function isInRunWindow(currentTurnId: string | null, runTurns: ReadonlySet<string>, reloadWindow: readonly string[] | null): boolean {
  if (currentTurnId !== null && runTurns.has(currentTurnId)) return true
  if (reloadWindow === null) return false
  return currentTurnId === null || reloadWindow.length === 0 || reloadWindow.includes(currentTurnId)
}

type Verdict = { allow: true } | { deny: string }

/**
 * Where a spelled path lands, from `$.fs.stat(path, { resolve: true })`: `real` is its realPath (every
 * link followed); `missing` the stat rejected (nothing there); `nowhere` it answered without a
 * realPath (a link that leads nowhere, or one a hook withheld). The d.ts: "a guard denies without it".
 */
export type Landing = { real: string } | 'missing' | 'nowhere'
/** The hook's answer per spelling; a spelling it did not resolve must answer `nowhere`. */
export type Resolve = (path: string) => Landing

const ALLOW: Verdict = { allow: true }
/** Refused anywhere in a Bash command, before any pattern: expansion and escapes. */
const EXPANSION = /[$`\\]/
/** Review ch L4 (2026-10-20): the find -name pattern is this session's `<sid>.jsonl` only, never a glob. */
const transcriptName = (ctx: RunContext) => escape(`${ctx.sessionId}.jsonl`)

/** Trims only the whitespace bash itself drops; `.trim()` also strips a non-breaking space or a CR, which bash passes on inside the argument. */
function trimShell(command: string): string {
  return command.replace(/^[ \t\n]+|[ \t\n]+$/g, '')
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function deny(why: string): Verdict {
  return { deny: `context-handoff automatic run: ${why}. Only the compact-crafter steps are allowed in this turn.` }
}

/**
 * An exact path as one shell word. The bare form requires the safe charset; each quoted form
 * requires that its quote does not occur inside the path. Expansion is refused separately.
 */
function pathArg(path: string): string {
  const dir = escape(path)
  const forms = [
    ...(/^[A-Za-z0-9_.\/~-]+$/.test(path) ? [dir] : []),
    ...(path.includes('"') ? [] : [`"${dir}"`]),
    ...(path.includes("'") ? [] : [`'${dir}'`]),
  ]
  return `(?:${forms.join('|')})`
}

/** The folders Read may open in the window (each ends with `/`). */
function readRoots(ctx: RunContext): string[] {
  const roots = [`${ctx.briefDir}/`, `${ctx.repoRoot}/skills/compact-crafter/`]
  if (typeof ctx.transcriptPath === 'string') roots.push(`${ctx.transcriptPath.replace(/\.jsonl$/, '')}/subagents/`)
  return roots
}

/** Read: an absolute path without `.` or `..` segments, under a read root or the transcript itself. */
function isAllowedRead(path: unknown, ctx: RunContext): boolean {
  if (typeof path !== 'string' || !path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.')) return false
  if (typeof ctx.transcriptPath === 'string' && path === ctx.transcriptPath) return true
  // Review ch L4 (2026-10-20): in the brief folder, only this session's files, never other sessions'.
  if (path.startsWith(`${ctx.briefDir}/`) && !path.startsWith(`${ctx.briefDir}/${ctx.sessionId}-`)) return false
  return readRoots(ctx).some(root => path.startsWith(root) && path.length > root.length)
}

/** check-snapshot.py's one argument: the Write rule, `<briefDir>/<sid>-*.md` in the safe charset, bare or quoted. */
function snapshotArg(ctx: RunContext): string {
  const path = `${escape(`${ctx.briefDir}/${ctx.sessionId}-`)}[A-Za-z0-9_.-]*\\.md`
  return `(?:(${path})|"(${path})"|'(${path})')`
}

function checkSnapshotForm(ctx: RunContext): RegExp {
  return new RegExp(`^python3 ${pathArg(`${ctx.repoRoot}/skills/compact-crafter/scripts/check-snapshot.py`)} ${snapshotArg(ctx)}$`)
}

/** The snapshot check-snapshot.py would read, unquoted, or null when the command is not that form. */
function checkSnapshotPath(command: unknown, ctx: RunContext): string | null {
  if (typeof command !== 'string' || EXPANSION.test(command)) return null
  const match = checkSnapshotForm(ctx).exec(trimShell(command))
  return match === null ? null : (match[1] ?? match[2] ?? match[3] ?? null)
}

/** The exact anchored forms; nothing else runs. */
function bashForms(ctx: RunContext): RegExp[] {
  const home = `(?:~|${escape(ctx.home)})`
  return [
    checkSnapshotForm(ctx),
    new RegExp(`^python3 ${pathArg(`${ctx.repoRoot}/skills/compact-crafter/scripts/snapshot-path.py`)} --session ${escape(ctx.sessionId)}(?: --dir ${pathArg(ctx.briefDir)})?$`),
    new RegExp(`^find ${home}/\\.claude/projects -maxdepth \\d+ -name (?:"${transcriptName(ctx)}"|'${transcriptName(ctx)}')(?: \\| head -\\d+)?$`),
  ]
}

function isAllowedBash(command: string, ctx: RunContext): boolean {
  if (EXPANSION.test(command)) return false
  return bashForms(ctx).some(form => form.test(trimShell(command)))
}

/** A snapshot name: the session id, then the safe ASCII charset, then `.md` (snapshot-path.py's names fit). */
const SNAPSHOT_NAME = /^[A-Za-z0-9_.-]*\.md$/

/**
 * Write: `<briefDir>/<sid>-*.md` in the safe ASCII charset. An ASCII target keeps the folder-listing
 * check to one direction: a planted non-ASCII entry that APFS folds to it (`ſ`, `ẞ`) must fold to it
 * in register.tsx's foldName too, which folds wider than APFS.
 */
function isAllowedWrite(path: unknown, ctx: RunContext): boolean {
  if (typeof path !== 'string' || !path.startsWith(`${ctx.briefDir}/`)) return false
  const name = path.slice(ctx.briefDir.length + 1)
  return name.startsWith(`${ctx.sessionId}-`) && SNAPSHOT_NAME.test(name.slice(ctx.sessionId.length + 1))
}

/** A root folder as `$.fs.stat` is asked for it: no trailing `/`. */
function folderOf(root: string): string {
  return root.replace(/\/+$/, '')
}

/**
 * The spellings the hook must resolve before `allowInRun` can judge where this call lands: the target
 * and every root it is judged under. Read, Write and check-snapshot.py's argument; nothing else names a file.
 * None for a spelling the lexical rule refuses: the d.ts guard places by spelling first, with no file
 * system call, so a refused path (an automount, a FIFO) is never touched.
 */
export function resolveTargets(call: { tool: string; input: Record<string, unknown> }, ctx: RunContext): string[] {
  if (call.tool === 'Read' && typeof call.input.file_path === 'string' && isAllowedRead(call.input.file_path, ctx)) {
    const transcript = typeof ctx.transcriptPath === 'string' ? [ctx.transcriptPath] : []
    return [call.input.file_path, ...readRoots(ctx).map(folderOf), ...transcript]
  }
  if (call.tool === 'Write' && typeof call.input.file_path === 'string' && isAllowedWrite(call.input.file_path, ctx)) return [call.input.file_path, ctx.briefDir]
  if (call.tool === 'Bash') {
    const path = checkSnapshotPath(call.input.command, ctx)
    return path === null ? [] : [path, ctx.briefDir]
  }
  return []
}

/** Where a spelling lands, or null when it does not resolve (missing, or leads nowhere). */
function landOf(path: string, resolve: Resolve): string | null {
  const at = resolve(path)
  return typeof at === 'object' ? folderOf(at.real) || '/' : null
}

/**
 * Read lands on the resolved transcript, or under one of the read roots, each resolved on its own
 * (the installed skill folder may be a link to the repo's). A realPath has every link followed and
 * `.`/`..` folded, so a plain prefix check on it is sound.
 */
function isLandedRead(path: string, ctx: RunContext, resolve: Resolve): boolean {
  const real = landOf(path, resolve)
  if (real === null) return false
  const transcript = typeof ctx.transcriptPath === 'string' ? landOf(ctx.transcriptPath, resolve) : null
  if (transcript !== null && real === transcript) return true
  return readRoots(ctx).some(root => {
    const folder = landOf(folderOf(root), resolve)
    return folder !== null && real.startsWith(`${folder}/`)
  })
}

/** A file in the brief folder: where it lands must obey the Write rule under the resolved brief folder. */
function isLandedBriefFile(path: string, ctx: RunContext, resolve: Resolve, isNewAllowed: boolean): boolean {
  const briefDir = landOf(ctx.briefDir, resolve)
  if (briefDir === null) return false
  const at = resolve(path)
  if (at === 'nowhere') return false
  // Nothing there yet (a Write): the name was checked, and the folder it lands in is the resolved brief folder.
  if (at === 'missing') return isNewAllowed
  return isAllowedWrite(at.real, { ...ctx, briefDir })
}

/**
 * The verdict for one tool call made while a turn of the automatic run is current. With `resolve` (the
 * hook always passes it) the target must also land inside: lexical checks alone let a symlink escape.
 */
export function allowInRun(call: { tool: string; input: Record<string, unknown> }, ctx: RunContext, resolve?: Resolve): Verdict {
  if (call.tool === ctx.handoffTool) return ALLOW
  if (call.tool === 'Read') {
    const path = call.input.file_path
    const isAllowed = isAllowedRead(path, ctx) && (resolve === undefined || isLandedRead(path as string, ctx, resolve))
    return isAllowed ? ALLOW : deny('Read is allowed only under the brief folder, the compact-crafter skill folder and this session\'s transcript')
  }
  if (call.tool === 'Write') {
    const path = call.input.file_path
    const isAllowed = isAllowedWrite(path, ctx) && (resolve === undefined || isLandedBriefFile(path as string, ctx, resolve, true))
    return isAllowed ? ALLOW : deny(`Write is allowed only to ${ctx.briefDir}/${ctx.sessionId}-*.md`)
  }
  if (call.tool === 'Bash') {
    const command = call.input.command
    const snapshot = checkSnapshotPath(command, ctx)
    const isLanded = snapshot === null || resolve === undefined || isLandedBriefFile(snapshot, ctx, resolve, false)
    return typeof command === 'string' && isAllowedBash(command, ctx) && isLanded
      ? ALLOW
      : deny(`this Bash command is not on the allowlist (snapshot-path.py, check-snapshot.py ${ctx.briefDir}/${ctx.sessionId}-*.md, find ~/.claude/projects -maxdepth N -name "<sid>.jsonl")`)
  }
  return deny(`the tool ${call.tool} is not allowed`)
}
