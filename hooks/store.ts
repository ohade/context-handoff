// The per-session state files (C5) over a small file interface: discovery,
// loading with reload recovery, persistence with retirement, and the per-load
// write guard. No `$` here: register.tsx passes its Host.

import { recoverAfterReload, initialState, reloadWindowOf } from './machine'
import type { Effect, MachineState, Phase } from './machine'
import { parseState, serializeState, stateFileName } from './state-file'

export type StoreFs = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<ReadonlyArray<{ name: string; kind: string; mtimeMs?: number }>>
  /** One handoff.log line (`state-read-failed <kind> <path>: <error>`); never awaited, never throws. */
  report?: (event: string, detail: string) => void
}

export function sessionFile(stateDir: string, sessionId: string): string | null {
  const name = stateFileName(sessionId)
  return name === null ? null : `${stateDir}/sessions/${name}`
}

/** A state file as read: its state (null when there is none), or why it could not be read. */
type ReadResult = { state: MachineState | null } | { failure: 'io' | 'parse'; why: string }

/**
 * Whether an error's text names a missing file (ENOENT), judged with the path cut out: a name the
 * model chose may itself contain `ENOENT`. The one rule for the state file and the armed window.
 */
export function isMissingFileError(why: string, path: string): boolean {
  return why.split(path).join('').includes('ENOENT')
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function readState(fs: StoreFs, path: string | null): Promise<ReadResult> {
  if (path === null || !(await fs.exists(path))) return { state: null }
  let text: string
  try {
    text = await fs.read(path)
  } catch (error) {
    // Removed between the exists check and the read: absent, not a read error.
    if (isMissingFileError(reasonOf(error), path)) return { state: null }
    fs.report?.('state-read-failed', `io ${path}: ${reasonOf(error)}`)
    return { failure: 'io', why: reasonOf(error) }
  }
  // parseState answers null for a torn or foreign file (state-file.ts).
  const state = parseState(text)
  if (state !== null) return { state }
  fs.report?.('state-read-failed', `parse ${path}: not a version 1 state file (${text.length} bytes)`)
  return { failure: 'parse', why: 'not a version 1 state file' }
}

/** For loading: a file that cannot be read or parsed reads as absent (reported); the next write replaces a corrupt one. */
async function stateOrNull(fs: StoreFs, path: string | null): Promise<MachineState | null> {
  const read = await readState(fs, path)
  return 'state' in read ? read.state : null
}

/** How long a session file may sit untouched before a load prunes it (W8, audit P4 finding E). */
export const SESSION_FILE_MAX_AGE_MS = 30 * 86_400_000
/** At most this many files per load, so one `rm` argv stays small; a later load takes the rest. */
export const SESSION_PRUNE_LIMIT = 500

/**
 * The `.json` files in `sessions/` untouched for more than SESSION_FILE_MAX_AGE_MS: a session that old
 * is over, and every load scans the folder. The loading session's own file is never stale, and an
 * entry without a modification time is kept.
 */
export function staleSessionFiles(entries: ReadonlyArray<{ name: string; kind: string; mtimeMs?: number }>, now: number, ownName: string): string[] {
  return entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.json') && e.name !== ownName)
    .filter(e => e.mtimeMs !== undefined && now - e.mtimeMs > SESSION_FILE_MAX_AGE_MS)
    .map(e => e.name)
    .slice(0, SESSION_PRUNE_LIMIT)
}

/** The newest CLEARING file stamped with this owner: what a reload left behind when the id changed. */
export async function findOwnClearing(fs: StoreFs, stateDir: string, ownerId: string): Promise<MachineState | null> {
  const dir = `${stateDir}/sessions`
  if (!(await fs.exists(dir))) return null
  let best: MachineState | null = null
  for (const entry of await fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const state = await stateOrNull(fs, `${dir}/${entry.name}`)
    if (state?.phase === 'CLEARING' && state.ownerId === ownerId && (!best || state.enteredAt > best.enteredAt)) best = state
  }
  return best
}

/** `reloadWindow`: the armed window to rebuild after a hot reload (reloadWindowOf of the own file), or null. */
export type Loaded = { state: MachineState; effects: Effect[]; persistedSessionId: string; reloadWindow: string[] | null }

/**
 * The machine for this load: the session's own file (recovered when not
 * IDLE), else this owner's CLEARING file left by a reload, else a fresh one.
 * Every returned state carries this load's owner and load id.
 */
export async function loadMachine(fs: StoreFs, stateDir: string, sessionId: string, ownerId: string, loadId: string, now: number): Promise<Loaded> {
  const stamp = (r: { state: MachineState; effects: Effect[] }, persistedSessionId: string, reloadWindow: string[] | null = null): Loaded => ({
    state: { ...r.state, ownerId, loadId },
    effects: r.effects,
    persistedSessionId,
    reloadWindow,
  })
  const own = await stateOrNull(fs, sessionFile(stateDir, sessionId))
  if (own && own.phase !== 'IDLE') return stamp(recoverAfterReload(own, sessionId, ownerId, now), sessionId, reloadWindowOf(own))
  const orphan = await findOwnClearing(fs, stateDir, ownerId)
  if (orphan) return stamp(recoverAfterReload(orphan, sessionId, ownerId, now), orphan.sessionId)
  if (own) return stamp({ state: own, effects: [] }, sessionId)
  return stamp({ state: initialState(sessionId, now, ownerId), effects: [] }, sessionId)
}

/**
 * The load time a load id starts with (`<ms>-<uuid>`, minted by register.tsx), or 0 for an id
 * without one (older files), so recency, not inequality, decides who owns a file.
 */
export function loadStamp(loadId: string): number {
  const match = /^(\d+)-/.exec(loadId)
  return match ? Number(match[1]) : 0
}

async function guardedWrite(fs: StoreFs, path: string, state: MachineState, loadId: string): Promise<boolean> {
  const read = await readState(fs, path)
  // A read error may hide a newer load's file: refuse, and the caller's persist-failure path runs.
  // A corrupt file is replaced, as an absent one is.
  if ('failure' in read && read.failure === 'io') throw new Error(`state-read-failed io ${path}: ${read.why}`)
  const onDisk = 'state' in read ? read.state : null
  // Only a newer load's file is refused: a reload claims the files the previous load wrote.
  if (onDisk && loadStamp(onDisk.loadId) > loadStamp(loadId)) return false
  await fs.write(path, serializeState({ ...state, loadId }))
  // The read above and this write are not one step: a newer load may write in between or right after.
  // Reading back catches a newer load that wrote after us, and this load then stops as superseded. A
  // newer write that this one overwrote is replaced by that load's next write, since ours is older.
  let after: ReadResult
  try {
    after = await readState(fs, path)
  } catch (error) {
    // The write itself succeeded: a failed read-back is reported, never turned into a failed write.
    fs.report?.('state-read-failed', `read-back ${path}: ${reasonOf(error)}`)
    return true
  }
  const written = 'state' in after ? after.state : null
  return !(written && written.loadId !== loadId && loadStamp(written.loadId) > loadStamp(loadId))
}

/**
 * Writes the machine under its session id. A session left behind is retired
 * as IDLE so no scan resumes it. A file a newer load has written is not
 * touched: the caller is a superseded module and must stop.
 */
export async function persistState(fs: StoreFs, stateDir: string, state: MachineState, previousSessionId: string, loadId: string): Promise<'written' | 'superseded'> {
  const path = sessionFile(stateDir, state.sessionId)
  if (path === null) return 'written'
  if (previousSessionId !== state.sessionId) {
    const old = sessionFile(stateDir, previousSessionId)
    const retired: MachineState = { ...state, sessionId: previousSessionId, phase: 'IDLE', cycleId: null, deadline: null }
    if (old !== null && !(await guardedWrite(fs, old, retired, loadId))) return 'superseded'
  }
  return (await guardedWrite(fs, path, state, loadId)) ? 'written' : 'superseded'
}

/** A state that could not be written: before the clear, abort (no clear without a visible, durable countdown). */
export function afterPersistFailure(phase: Phase): 'abort' | 'continue' {
  return phase === 'BRIEFING' || phase === 'GRACE' ? 'abort' : 'continue'
}
