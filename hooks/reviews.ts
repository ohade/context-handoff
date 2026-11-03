// How many Plannotator reviews are open for a session, read from Plannotator's own store. Read-only,
// never throws. A handoff clears the session, and Plannotator reattaches an open review only when that
// same session resumes, so the handoff waits while one is open.
//
// Contract read from Plannotator 0.28.7 (same as 0.28.6), not copied: the store holds `launches[]`
// records; a launch folder holds `stdin` while it lives, and a decision claims `settled/`
// (launch.ts:56 SETTLED_DIR) and then writes `settled/delivered` (controller.ts:217 SETTLED_DELIVERED),
// or `settled/reported` when Plannotator gave up delivering it and reported it saved on disk
// (controller.ts:218 SETTLED_REPORTED, 459). Plannotator counts both as done (controller.ts:425-426).

/** The file calls the reader makes (register.tsx passes the host's `$.fs`). */
export type ReviewFs = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<ReadonlyArray<{ name: string; kind: string }>>
}

/** `count` open reviews, or `unknown` with the error class only (the store holds `bridgeToken`, so no content). */
export type ReviewRead =
  | { count: number; storePath: string }
  | { unknown: true; errorClass: string; storePath: string }

const STORE_PREFIX = 'plannotator_'
const STORE_SUFFIX = '.json'
const SETTLED_DIR = 'settled'
const SETTLED_DELIVERED = `${SETTLED_DIR}/delivered`
const SETTLED_REPORTED = `${SETTLED_DIR}/reported`

/** The store folder: the override env when set, else `~/.claude/plugins/store`. */
export function resolveReviewStoreDir(home: string, override: string | undefined): string {
  return override !== undefined && override !== '' ? override : `${home}/.claude/plugins/store`
}

/** The files the reader looks at, as logs and notices name them. */
export function reviewStorePath(storeDir: string): string {
  return `${storeDir}/${STORE_PREFIX}*${STORE_SUFFIX}`
}

/** A failure the reader names by class only. */
class ReviewStateError extends Error {
  constructor(readonly errorClass: string) {
    super(errorClass)
  }
}

function errorClassOf(error: unknown): string {
  if (error instanceof ReviewStateError) return error.errorClass
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') return name
  }
  return 'unknown-error'
}

type Launch = { id: string; dir: string }

/** This session's launch records in one store file: only `id`, `sessionId`, `dir` and `closedByAgent` are read. */
function launchesOf(text: string, sessionId: string): Launch[] {
  const parsed: unknown = JSON.parse(text)
  const launches = typeof parsed === 'object' && parsed !== null ? (parsed as { launches?: unknown }).launches : undefined
  if (!Array.isArray(launches)) throw new ReviewStateError('no-launches-array')
  const mine: Launch[] = []
  for (const raw of launches) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as { id?: unknown; sessionId?: unknown; dir?: unknown; closedByAgent?: unknown }
    if (record.sessionId !== sessionId) continue
    // closedByAgent is read and ignored on purpose: a record the agent closed still counts while its folder says open.
    if (typeof record.dir !== 'string' || record.dir === '') throw new ReviewStateError('bad-launch-record')
    mine.push({ id: typeof record.id === 'string' ? record.id : record.dir, dir: record.dir })
  }
  return mine
}

/** Open: the folder holds `stdin`, and either no `settled/` or `settled/` with neither `delivered` nor `reported`. */
async function isOpen(fs: ReviewFs, dir: string): Promise<boolean> {
  if (!(await fs.exists(`${dir}/stdin`))) return false
  if (!(await fs.exists(`${dir}/${SETTLED_DIR}`))) return true
  if (await fs.exists(`${dir}/${SETTLED_DELIVERED}`)) return false
  return !(await fs.exists(`${dir}/${SETTLED_REPORTED}`))
}

async function countOnce(sessionId: string, storeDir: string, fs: ReviewFs): Promise<number> {
  if (!(await fs.exists(storeDir))) return 0
  const names = (await fs.list(storeDir)).map(e => e.name).filter(n => n.startsWith(STORE_PREFIX) && n.endsWith(STORE_SUFFIX)).sort()
  const launches = new Map<string, string>()
  for (const name of names) {
    for (const launch of launchesOf(await fs.read(`${storeDir}/${name}`), sessionId)) launches.set(launch.id, launch.dir)
  }
  let count = 0
  for (const dir of launches.values()) if (await isOpen(fs, dir)) count += 1
  return count
}

/**
 * What register.tsx does with each read: a log line when the answer changes (the path it looked at
 * included), and one pinned notice per session, when the state reads unknown on two consecutive
 * checks or a review holds a handoff past the ceiling. Lost on hot reload, like the rest of Runtime.
 */
export class ReviewWatch {
  private lastLog: string | null = null
  private unknownStreak = 0
  private streakSession: string | null = null
  private readonly noticed = new Set<string>()

  /** `when`: a cycle-start read (turn end, auto compaction, handoff_now), or one after the cycle started. */
  observe(sessionId: string, read: ReviewRead, when: 'cycle-start' | 'in-cycle' = 'cycle-start'): { log: string | null; notice: string | null } {
    const line = 'unknown' in read ? `unknown errorClass=${read.errorClass} store=${read.storePath}` : `count=${read.count} store=${read.storePath}`
    const log = line === this.lastLog ? null : line
    this.lastLog = line
    // Only a cycle-start read holds the handoff on unknown, so only those feed the notice.
    if (when === 'in-cycle') return { log, notice: null }
    // Consecutive checks of one session: a clear starts the count again.
    if (this.streakSession !== sessionId) this.unknownStreak = 0
    this.streakSession = sessionId
    if (!('unknown' in read)) {
      this.unknownStreak = 0
      return { log, notice: null }
    }
    this.unknownStreak += 1
    const text = `context-handoff: Plannotator state is unknown (${read.errorClass}), so the handoff waits; store: ${read.storePath}`
    return { log, notice: this.unknownStreak >= 2 ? this.claim(sessionId, text) : null }
  }

  held(sessionId: string, reason: string, storePath: string): string | null {
    return this.claim(sessionId, `context-handoff: ${reason} holds the handoff past the ceiling; store: ${storePath}`)
  }

  private claim(sessionId: string, text: string): string | null {
    if (this.noticed.has(sessionId)) return null
    this.noticed.add(sessionId)
    return text
  }
}

/**
 * Open reviews of `sessionId` across every `plannotator_*.json` in `storeDir` (a union). A missing
 * folder or no match is 0; a file without a `launches` array, an unparseable one or a failed fs call
 * is unknown, after one retry. Never throws.
 */
export async function openPlannotatorReviews(sessionId: string, storeDir: string, fs: ReviewFs): Promise<ReviewRead> {
  const storePath = reviewStorePath(storeDir)
  let errorClass = 'unknown-error'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { count: await countOnce(sessionId, storeDir, fs), storePath }
    } catch (error) {
      errorClass = errorClassOf(error)
    }
  }
  return { unknown: true, errorClass, storePath }
}
