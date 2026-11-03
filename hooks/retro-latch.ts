// The /retro Phase 5 latch a handoff carries to the new session id (TRACK-23). Pure.
// retro-gate.sh owns the latch files; this module only decides and builds its command.
// It never names an approved-* file: only the user releases the latch.

/** `sourceId` (TRACK-23 v3, E1): the session whose latch files these are, which the carry copies from. */
export type RetroLatchSnapshot = { active: boolean; approved: boolean; sourceId?: string }
export type RetroCarryOutcome = { carried: true } | { skipped: string } | { failure: string }

/** retro-gate.sh SESSION_ID_SHAPE. */
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/

/** Below TIMEOUTS_MS.carry (10 s), so a slow carry reports its own failure before the CARRYING deadline. */
export const RETRO_CARRY_TIMEOUT_MS = 5_000

/** The folder retro-phase5-gate.sh reads. The carry pins it, so no inherited override moves the copy. */
function retroStateDir(home: string): string {
  return `${home}/.claude/state/retro`
}

export function retroPaths(home: string, sessionId: string): { active: string; approved: string } | null {
  if (!SAFE_SESSION.test(sessionId)) return null
  const dir = retroStateDir(home)
  return { active: `${dir}/active-${sessionId}`, approved: `${dir}/approved-${sessionId}` }
}

/** Home-based, like retro-phase5-gate.sh itself. */
export function retroGatePath(home: string): string {
  return `${home}/.claude/skills/retro/scripts/retro-gate.sh`
}

/** Carry only a latch that was active and unapproved when the brief was queued. */
export function needsRetroCarry(snapshot: RetroLatchSnapshot | null | undefined): boolean {
  return snapshot !== null && snapshot !== undefined && snapshot.active && !snapshot.approved
}

export function retroCarryArgv(home: string, fromSessionId: string, toSessionId: string): string[] | null {
  if (!SAFE_SESSION.test(fromSessionId) || !SAFE_SESSION.test(toSessionId)) return null
  if (fromSessionId === toSessionId) return null
  return ['env', `RETRO_STATE_DIR=${retroStateDir(home)}`, 'bash', retroGatePath(home), 'carry', fromSessionId, toSessionId]
}

/**
 * retro-gate.sh carry: 0 carried; 5 approved before the carry. 6 (no active-<from>) is a release only
 * when the mod's own recheck also finds no active-<from>; otherwise the two disagree and it fails.
 */
export function classifyRetroCarry(exitCode: number, stderr: string, isSourceStillActive: boolean): RetroCarryOutcome {
  if (exitCode === 0) return { carried: true }
  if (exitCode === 5) return { skipped: 'approved since the brief was queued' }
  if (exitCode === 6 && !isSourceStillActive) return { skipped: 'latch released since the brief was queued' }
  if (exitCode === 6) return { failure: 'retro-gate.sh carry exit 6, but the source latch is still active' }
  return { failure: `retro-gate.sh carry exit ${exitCode}: ${stderr.trim().slice(0, 200)}` }
}

/** TRACK-23 v3 (E1): one session's latch files, as register.tsx reads them. */
export type RetroLatchFiles = { active: boolean; approved: boolean; carried: boolean }

/** retro-gate.sh carry writes carried-<from> naming <to> (E2); the gate's lineage walk then skips <from>. */
export function retroCarriedPath(home: string, sessionId: string): string | null {
  if (!SAFE_SESSION.test(sessionId)) return null
  return `${retroStateDir(home)}/carried-${sessionId}`
}

/**
 * TRACK-23 v3 (E1): the latch a handoff carries. This session's own when active-<own> exists; else the
 * previous session's when it is active, unapproved and was never carried on (no carried-<previous>);
 * else none. The handoff's state files are one hop deep (store.ts retires a file under its own id), so
 * re-carrying the nearest unapproved latch at every handoff is what keeps it past the second hop.
 */
export function retroLatchSource(ownId: string, own: RetroLatchFiles, previousId: string | null, previous: RetroLatchFiles | null): RetroLatchSnapshot {
  if (own.active) return { active: true, approved: own.approved, sourceId: ownId }
  if (previousId !== null && previous !== null && previous.active && !previous.approved && !previous.carried) {
    return { active: true, approved: false, sourceId: previousId }
  }
  return { active: false, approved: false }
}

/** TRACK-23 v4 (G1d), v5 (G4b): the three file calls the latch reader makes; the engine's `$.fs` answers all three. */
export type RetroLatchFs = { exists: (path: string) => Promise<boolean>; stat: (path: string) => Promise<{ kind: string; isLink: boolean }>; read: (path: string) => Promise<string> }

/** TRACK-23 v5 (G4): the marker's first line, spaces, tabs and CR trimmed, is one session id. retro-phase5-gate.sh uses the same shape. */
const CARRIED_LINE = /^[ \t\r]*([A-Za-z0-9][A-Za-z0-9_-]{7,63})[ \t\r]*$/

/**
 * TRACK-23 v4 (G1d), v5 (G4b): the session id carried-<id> names, or null. Only a regular file that is
 * not a symbolic link counts, the gate's `-f && ! -L`, and only its first 128 characters, NUL bytes
 * dropped as bash's command substitution drops them, as the gate reads it with `head -c 128`. A folder,
 * a link, anything else, a stat or read that fails, or a first line that is not one session id is null.
 */
async function carriedMarkerTarget(fs: RetroLatchFs, path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    if (stat.kind !== 'file' || stat.isLink) return null
    const head = (await fs.read(path)).slice(0, 128).replace(/\0/g, '')
    return CARRIED_LINE.exec(head.split('\n')[0] ?? '')?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * TRACK-23 v3 (E1), v4 (G1d), v5 (G4b): one session's latch files, or null for an unsafe id. `carried`
 * is true only when carried-<id> names `carriedTo`, the session reading it: a carry to any other id,
 * a forged one included, leaves the latch in force (the fail-safe side). With `carriedTo` null it is false.
 */
export async function readRetroLatchFiles(fs: RetroLatchFs, home: string, sessionId: string, carriedTo: string | null): Promise<RetroLatchFiles | null> {
  const paths = retroPaths(home, sessionId)
  const carried = retroCarriedPath(home, sessionId)
  if (paths === null || carried === null) return null
  const target = carriedTo === null ? null : await carriedMarkerTarget(fs, carried)
  return { active: await fs.exists(paths.active), approved: await fs.exists(paths.approved), carried: target !== null && target === carriedTo }
}
