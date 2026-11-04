// context-handoff: the only file that calls `$`. It turns engine events into
// machine events (machine.ts), runs the effects the machine returns, and
// serves handoff_now (the manual handoff), the compaction veto and the 65% warning rewrite.
// Host-binding examples from Anthropic code-modernization, modified for this plugin.
// See THIRD_PARTY_NOTICES.md and licenses/Apache-2.0.txt for upstream attribution.
// Every engine call that must not run inside a hook is deferred with
// `$.clock.after(0)`.

import type { EngineInterface, HookFailure, Register, ToolCallArgs } from 'claude-code'

import { allowInRun, isInRunWindow, resolveTargets } from './allowlist'
import type { Landing, RunContext } from './allowlist'
import { appendOutcome, briefFileName, checkSnapshot, composeBrief, localTime, parseTemplate, parseUtcOffset, seedNote, seedText, verifyBrief } from './brief'
import type { BriefHeader, Template } from './brief'
import { checkArmedPath, checkArmedSnapshot, extractorArgv, gateHandoffNow, HANDOFF_COMMAND, HANDOFF_NOW_DESCRIPTION, HANDOFF_NOW_INPUT_SCHEMA, HANDOFF_NOW_NAME, HANDOFF_NOW_QUEUED, HANDOFF_NOW_REFUSAL, runEndedFor } from './handoff-now'
import type { TurnInfo } from './handoff-now'
import { resolveConfig, TIMEOUTS_MS } from './config'
import type { HandoffConfig, HandoffEnv } from './config'
import { appendArgv, formatLogLine } from './log'
import { acceptsTranscript, initialState, isAutoRunTurn, isBeforeClear, isRunCallable, needsDecisionCheck, shouldVetoCompaction, step } from './machine'
import type { Effect, MachineEvent, MachineState, MarkerSnapshot, TurnEndReason } from './machine'
import { carryWrites, decideCarry, markerPaths } from './markers'
import { classifyRetroCarry, needsRetroCarry, readRetroLatchFiles, RETRO_CARRY_TIMEOUT_MS, retroCarryArgv, retroGatePath, retroLatchSource, retroPaths } from './retro-latch'
import type { RetroLatchFiles, RetroLatchSnapshot } from './retro-latch'
import { parsePid, resolveOwner } from './owner'
import { errorText } from './errors'
import { pollForNewId } from './poll'
import { CHECKPOINT_TOOL, RESTORE_TOOL, checkpointOf, restorationOf } from './track-contract'
import type { TrackCheckpoint } from './track-contract'
import { answerText, argumentsKey, createdStepId, isMarked, MARK_TOOL, PREPARATION_TOOLS, preparationTitle, STEPS_TOOL } from './preparation'
import type { Preparation } from './preparation'
import { afterPersistFailure, isMissingFileError, loadMachine, persistState, sessionFile, staleSessionFiles } from './store'
import type { StoreFs } from './store'
import { autoRunCycleOf, isAmqDoorbell, isTypedPrompt, originOf, stopBlockCancel, stopRecord, transcriptRecord, TurnTracker } from './turns'
import { rewriteCompactWarning } from './warning'
import { plannotatorRefusal, reachesThreshold } from './guards'
import { openPlannotatorReviews, resolveReviewStoreDir, reviewStorePath, ReviewWatch } from './reviews'
import type { ReviewRead } from './reviews'
import { decideFactsReuse, queueReminder } from './nudge'
import type { FactsKey, TranscriptStat } from './nudge'
import { readRelay } from './relay'
import { declaredRecords, declaredRemoval, openDecisionRows, openRowsHint, openRowsRecord, pendingCoverage, pendingItems, removedDecisions, sectionThreePendingLines, strictPendingLines, strictRecords, uncoveredCount, unionDeclared } from './pending-items'
import type { Declared } from './pending-items'
import { coveredItems, NOTES_ONLY, waitingRowsOf } from './decision-hold'
import type { WaitingRows } from './decision-hold'
import { parseState } from './state-file'
import { responseNotice, responseReceiptOf, responseRowId } from './response-replay'

type Engine = EngineInterface

/**
 * The engine as a hook's `$` bound it: timers, background work and button
 * presses reach the engine through these closures (the engine refuses `$`
 * itself stored in an object). Pattern: code-modernization hooks/register.ts hostOf.
 */
type Host = {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => unknown
  sleep: (ms: number) => Promise<void>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<Array<{ name: string; kind: string; mtimeMs?: number }>>
  stat: (path: string) => Promise<TranscriptStat & { kind: string; isLink: boolean }>
  run: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  runCommand: (command: string, args?: string) => Promise<unknown>
  listCommands: () => ReturnType<Engine['command']['list']>
  listTools: () => ReturnType<Engine['tool']['list']>
  callTool: (args: ToolCallArgs) => ReturnType<Engine['tool']['call']>
  sessionId: () => Promise<string>
  sessionEnvId: () => Promise<string | undefined>
  setActivityGeneration: (value: string) => Promise<void>
  usage: () => ReturnType<Engine['session']['usage']>
  submit: (text: string) => Promise<{ drop?: string }>
  appendNote: (text: string) => Promise<unknown>
  appendNotice: (text: string) => Promise<unknown>
  placeResponse: (id: string) => ReturnType<Engine['ui']['place']>
  fill: (text: string) => Promise<{ isFilled: boolean }>
  readPrompt: () => Promise<{ text: string }>
  status: (text: string | undefined) => void
  log: (text: string) => void
  debug: (text: string) => void
  invalidate: () => void
}

function hostOf($: Engine): Host {
  return {
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    sleep: ms => $.clock.sleep(ms),
    exists: path => $.fs.exists(path),
    read: path => $.fs.read(path) as Promise<string>,
    write: (path, text) => $.fs.write(path, text),
    list: path => $.fs.list(path),
    stat: path => $.fs.stat(path),
    run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
    runCommand: (command, args) => $.command.run(args === undefined ? { command } : { command, args }),
    listCommands: () => $.command.list(),
    listTools: () => $.tool.list(),
    callTool: args => $.tool.call(args),
    sessionId: () => $.session.id(),
    sessionEnvId: () => $.env.get('CLAUDE_SESSION_ID'),
    setActivityGeneration: value => $.env.set('CONTEXT_HANDOFF_ACTIVITY_GENERATION', value),
    usage: () => $.session.usage(),
    submit: text => $.prompt.submit({ text }) as Promise<{ drop?: string }>,
    appendNote: text => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }),
    appendNotice: text => $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }),
    placeResponse: id => $.ui.place({ id }),
    fill: text => $.prompt.fill({ text }),
    readPrompt: () => $.prompt.read(),
    status: text => $.ui.status(text),
    log: text => $.ui.log(text),
    debug: text => $.ui.log(text, { to: 'debug' }),
    invalidate: () => $.ui.invalidate('ui.render'),
  }
}

const EXTRACTOR = 'scripts/transcript-facts.py'
const TEMPLATE = 'skills/compact-crafter/reference/snapshot-template.md'
const WATCHDOG_MS = 1_000
const FACTS_TIMEOUT_MS = 120_000

type Band = { kind: 'grace'; deadline: number } | { kind: 'manual' } | null

/** Everything a live (non-inert) load holds. Lost on hot reload; the state file carries the machine. */
type Runtime = {
  host: Host
  config: HandoffConfig
  ownerId: string
  loadId: string
  stateDir: string
  briefDir: string
  home: string
  repoRoot: string
  utcOffsetMinutes: number
  machine: MachineState
  persistedSessionId: string
  toolName: string | null
  band: Band
  turns: TurnTracker
  /** Turns of the automatic run (bound by the machine); the allowlist holds until each one ends. */
  runTurns: Set<string>
  /**
   * The window rebuilt after a hot reload from the persisted run turn ids ([] = unknown): every call
   * outside the allowlist is denied until the first turn end or typed prompt. Null otherwise.
   */
  reloadWindow: string[] | null
  /** Tool calls made in the run's turns, against autoRunToolCap. */
  runToolCalls: number
  /**
   * TRACK-25: every decision a snapshot the automatic run read declared in section 3 (multiset
   * union), and the most `- Pending: ` lines one snapshot had; a later snapshot may not drop one.
   */
  runDeclared: { cycleId: string; records: Declared[]; lines: number } | null
  pendingSeed: { cycleId: string; text: string; note: string; via: 'submit' | 'initial' } | null
  initialSeed: string | null
  isInSessionStart: boolean
  hasPinnedNotice: boolean
  lastTokens: number | null
  /** A typed prompt was submitted over the running turn (prompt.submit `turnId` set): it waits to start the next one. */
  isTypedDuringTurn: boolean
  /**
   * The text queued for the next successful main tool result: the nudge the machine just issued (the first one,
   * or a held 👉 decision's re-arm), or TRACK-33's background reminder (nudge.ts queueReminder).
   */
  pendingNudge: string | null
  /** The extractor's background precompute from the nudge, keyed by session id and transcript size/mtime. */
  facts: { key: FactsKey; path: string; result: Promise<FactsResult> } | null
  /** Bumped by every invalidation; a precompute started under an older value never stores its result. */
  factsGeneration: number
  /** Plannotator's store folder (reviews.ts); CONTEXT_HANDOFF_PLANNOTATOR_STORE_DIR overrides it. */
  reviewStoreDir: string
  /** The review reads' change log and the one pinned review notice per session. */
  reviews: ReviewWatch
  /** The seed's turn in the session it starts, bound at its turn.start: did it call a tracker restore tool. */
  seedTurn: { text: string; turnId: string | null; isCalled: boolean } | null
  activityRevision: number
  activityGeneration: string
  activityWrites: Promise<void>
  pollingCycle: string | null
  trackCheckpoint: { cycleId: string; checkpoint: TrackCheckpoint | null } | null
  checkpointAttempts: { cycleId: string; used: number } | null
  restoredCycle: string | null
  restoredReceipt: string | null
  /** TRACK-25 (runtime-only): the cycle started at the decision bound; its null-track_id items are notes only. Cleared when that cycle ends. */
  decisionLimitCycle: string | null
  /** TRACK-25 (runtime-only): the nudge window (`nudge.at`) whose one decision re-arm was delivered; a hot reload resets it. */
  rearmedWindow: number | null
  /** Startup and seed delivery must both await the one append in this load. */
  replayInFlight: Promise<void> | null
  /** Handoff-gate (runtime-only): the mod's own Track preparation step of the current cycle or handoff_now call. */
  preparation: Preparation | null
  /** Manual preparations made in this load, for a key per handoff_now call. */
  manualPreparations: number
  /** The mod's own Track calls raised from a hook other than the guard, by exact arguments: the guard admits each once (E-H1). */
  ownTrackCalls: Array<{ tool: string; key: string }>
}

/** The tools seed item 0 asks the seeded turn to call. */
const RESTORE_TOOLS: ReadonlySet<string> = new Set(['mcp__track__restore_tracker', 'mcp__track__restore_steps'])

type FactsResult = { markdown: string } | { failure: string }

/** The skill the automatic run starts, as $.command.run names it (no slash). */
const SKILL_COMMAND = HANDOFF_COMMAND.slice(1)

let rt: Runtime | null = null
let chain: Promise<void> = Promise.resolve()

// ---- small helpers -------------------------------------------------------------

async function readEnv($: Engine): Promise<HandoffEnv & { stateDir?: string; briefDir?: string; owner?: string; home?: string; reviewStore?: string }> {
  return {
    CONTEXT_HANDOFF_THRESHOLD_PERCENT: await $.env.get('CONTEXT_HANDOFF_THRESHOLD_PERCENT'),
    CONTEXT_HANDOFF_THRESHOLD_TOKENS: await $.env.get('CONTEXT_HANDOFF_THRESHOLD_TOKENS'),
    CONTEXT_HANDOFF_MIN_GROWTH_TOKENS: await $.env.get('CONTEXT_HANDOFF_MIN_GROWTH_TOKENS'),
    CONTEXT_HANDOFF_MAX_AUTO_CHAIN: await $.env.get('CONTEXT_HANDOFF_MAX_AUTO_CHAIN'),
    CONTEXT_HANDOFF_AUTO_RUN_TIMEOUT_SECONDS: await $.env.get('CONTEXT_HANDOFF_AUTO_RUN_TIMEOUT_SECONDS'),
    CONTEXT_HANDOFF_AUTO_RUN_TOOL_CAP: await $.env.get('CONTEXT_HANDOFF_AUTO_RUN_TOOL_CAP'),
    CONTEXT_HANDOFF_CEILING_TOKENS: await $.env.get('CONTEXT_HANDOFF_CEILING_TOKENS'),
    CONTEXT_HANDOFF_NUDGE_TURN_LIMIT: await $.env.get('CONTEXT_HANDOFF_NUDGE_TURN_LIMIT'),
    CONTEXT_HANDOFF_CLEAR_GRACE_SECONDS: await $.env.get('CONTEXT_HANDOFF_CLEAR_GRACE_SECONDS'),
    CONTEXT_HANDOFF_SEED_VIA: await $.env.get('CONTEXT_HANDOFF_SEED_VIA'),
    CONTEXT_HANDOFF_DISABLE: await $.env.get('CONTEXT_HANDOFF_DISABLE'),
    stateDir: await $.env.get('CONTEXT_HANDOFF_STATE_DIR'),
    briefDir: await $.env.get('CONTEXT_HANDOFF_BRIEF_DIR'),
    owner: await $.env.get('CONTEXT_HANDOFF_OWNER'),
    home: await $.env.get('HOME'),
    reviewStore: await $.env.get('CONTEXT_HANDOFF_PLANNOTATOR_STORE_DIR'),
  }
}

/** One line per event, ISO time first; each line its own O_APPEND write (log.ts). */
async function writeLog(host: Host, stateDir: string, sessionId: string, event: string, detail: string): Promise<void> {
  try {
    const line = formatLogLine(new Date(await host.now()).toISOString(), sessionId, event, detail)
    const run = await host.run(appendArgv(`${stateDir}/handoff.log`, line), 5_000)
    if (run.exitCode !== 0) host.debug(`context-handoff: log append exit ${run.exitCode}: ${run.stderr.slice(0, 200)}`)
  } catch (error) {
    host.debug(`context-handoff: log write failed: ${errorText(error)}`)
  }
}

/** The store's file interface: the host, with a state file that cannot be read reported to handoff.log. */
function storeFsOf(host: Host, stateDir: string, sessionId: string): StoreFs {
  return { ...host, report: (event, detail) => void writeLog(host, stateDir, sessionId, event, detail) }
}

function log(event: string, detail: string): Promise<void> {
  if (!rt) return Promise.resolve()
  return writeLog(rt.host, rt.stateDir, rt.machine.sessionId, event, detail)
}

/**
 * A `.catch` handler's log line. Not awaited: the handler's grace is 1 s (HookBudget.catchMs), and
 * past it the hook is absent as if it had no handler. `log` never rejects.
 */
/**
 * A name folded wider than a case-insensitive, normalization-insensitive file system (APFS default)
 * folds it: compatibility forms (`ſ`, the Kelvin sign) and full case mappings (`ß`) fold to ASCII.
 * Wider only adds matches, and a match denies. The Write rule keeps the target itself ASCII.
 */
function foldName(name: string): string {
  // To a fixed point: `ẞ` lowers to `ß`, which only uppercasing turns into `SS`.
  let folded = name.normalize('NFKC')
  for (let pass = 0; pass < 4; pass += 1) {
    const next = folded.toLowerCase().toUpperCase().toLowerCase().normalize('NFKC')
    if (next === folded) break
    folded = next
  }
  return folded
}

/**
 * Whether the path's folder lists its name, compared folded: on APFS a link planted as `X-a.md` is
 * what a stat of `x-A.md` follows. A folder that cannot be listed counts as listing it (fail closed).
 */
async function isListed($: Engine, path: string): Promise<boolean> {
  const cut = path.lastIndexOf('/')
  const name = foldName(path.slice(cut + 1))
  try {
    return (await $.fs.list(cut <= 0 ? '/' : path.slice(0, cut))).some(entry => foldName(entry.name) === name)
  } catch (error) {
    void log('auto-run-stat', `list ${path}: ${errorText(error)}`)
    return true
  }
}

/**
 * The tool calls the guard judged inside the armed window, by tool_use_id, until the guard answers.
 * A guard that fails is judged by the window its call started in, not the one its `.catch` sees: the
 * run turn may end, or a reload replace `rt`, while the guard waits.
 */
const guardedCalls = new Set<string>()

function callKey(e: unknown): string | null {
  const id = (e as { tool_use_id?: unknown }).tool_use_id
  return typeof id === 'string' && id !== '' ? id : null
}

function logHookFailure(event: string, error: HookFailure): void {
  void log('hook-failed', `${event} ${error.kind}: ${error.message ?? '-'}`)
}

/**
 * Where each spelling lands, by `$.fs.stat(path, { resolve: true })`. A stat that rejects ENOENT is
 * `missing` (nothing there yet) only when its folder's listing does not name it either: a dangling
 * link is listed (as `other`) whether or not the stat follows it. Any other rejection, a listed name,
 * a folder that cannot be listed, or an answer without realPath is `nowhere`. Every rejection is
 * logged (`auto-run-stat`, not awaited), so the engine's own words are on record.
 */
async function landingsOf($: Engine, paths: readonly string[]): Promise<Map<string, Landing>> {
  const landing = async (path: string): Promise<Landing> => {
    try {
      const stat = await $.fs.stat(path, { resolve: true })
      return stat.realPath === undefined ? 'nowhere' : { real: stat.realPath }
    } catch (error) {
      const why = errorText(error)
      void log('auto-run-stat', `${path} ${why}`)
      // The model chose the name, and `<sid>-ENOENT.md` is a valid one: isMissingFileError cuts the path out.
      if (!isMissingFileError(why, path)) return 'nowhere'
      return (await isListed($, path)) ? 'nowhere' : 'missing'
    }
  }
  return new Map(await Promise.all(paths.map(async path => [path, await landing(path)] as const)))
}

async function isKillSwitchOn(r: Runtime): Promise<boolean> {
  return r.config.isDisabledByEnv || (await r.host.exists(`${r.stateDir}/DISABLED`))
}

/** A notice pinned under the prompt until the next typed prompt clears it. */
async function pinStatus(r: Runtime, text: string): Promise<void> {
  r.host.status(text)
  r.hasPinnedNotice = true
  await log('notice', text)
}

/**
 * The open-review count of `sessionId` (reviews.ts never throws, so no caller's work is skipped): a
 * changed answer is logged with the path read, and unknown on two cycle-start reads in a row pins the session's notice.
 */
async function readReviews(r: Runtime, sessionId: string, when: 'cycle-start' | 'in-cycle' = 'cycle-start'): Promise<ReviewRead> {
  const read = await openPlannotatorReviews(sessionId, r.reviewStoreDir, r.host)
  const seen = r.reviews.observe(sessionId, read, when)
  if (seen.log !== null) await log('plannotator-reviews', seen.log)
  if (seen.notice !== null) await pinStatus(r, seen.notice)
  return read
}

/** The `Measured.openReviews` value of a read. */
function openReviewsOf(read: ReviewRead): number | 'unknown' {
  return 'unknown' in read ? 'unknown' : read.count
}

/** A confirmed open review: only this cancels a started cycle (an unknown read holds only at cycle start). */
function confirmedOpen(read: ReviewRead): number {
  return 'unknown' in read ? 0 : read.count
}

async function readOrNull(host: Host, path: string): Promise<string | null> {
  try {
    return (await host.exists(path)) ? await host.read(path) : null
  } catch (error) {
    await log('read-failed', `${path}: ${errorText(error)}`)
    return null
  }
}

/** Native activity invalidates old observations synchronously, before any engine await. */
async function invalidateActivity(r: Runtime): Promise<void> {
  r.activityRevision += 1
  r.activityGeneration = `${r.loadId}:${r.activityRevision}`
  const generation = r.activityGeneration
  // Tool calls overlap. Finish child-env writes in event order, so a delayed
  // older write cannot leave the next Stop hook stamped with an old token.
  const write = r.activityWrites.then(async () => {
    if (rt === r) await r.host.setActivityGeneration(generation)
  }).catch(error => log('activity-generation-failed', errorText(error)))
  r.activityWrites = write
  await write
}

async function relayObservation(r: Runtime) {
  return readRelay(await readOrNull(r.host, `${r.stateDir}/relay/${r.machine.sessionId}.json`), {
    sessionId: r.machine.sessionId, owner: r.ownerId, generation: r.activityGeneration,
  })
}

/** Stop command hooks can finish just after turn.complete. Only this lifecycle path waits. */
async function refreshActivity(r: Runtime, generation: string, withinMs = 0): Promise<boolean> {
  const deadline = await r.host.now() + withinMs
  while (rt === r && generation === r.activityGeneration) {
    const record = await relayObservation(r)
    if (rt !== r || generation !== r.activityGeneration) return false
    if (record.stop !== null) {
      await dispatch(record.stop)
      return generation === r.activityGeneration
    }
    if (await r.host.now() >= deadline) break
    await r.host.sleep(75)
  }
  if (rt === r && generation === r.activityGeneration) {
    await dispatch({ type: 'stop', backgroundTasks: null, sessionCrons: null, transcriptPath: null })
  }
  return false
}

// ---- the dispatcher --------------------------------------------------------------

/**
 * Feeds one event through the machine and runs its effects, one event at a
 * time across the whole module (hooks run concurrently). Effects that answer
 * at once return follow-up events, processed before this call resolves;
 * effects that wait (fork, extractor, clear, seed) dispatch later on their own.
 */
function dispatch(event: MachineEvent): Promise<void> {
  // Never rejects: a hook awaiting it must still call next(e).
  const run = chain.then(() => processEvents(event)).catch(error => log('dispatch-failed', `${event.type}: ${errorText(error)}`))
  chain = run
  return run
}

async function processEvents(first: MachineEvent): Promise<void> {
  const pending: MachineEvent[] = [first]
  while (pending.length > 0 && rt) {
    const r = rt
    const event = pending.shift() as MachineEvent
    const result = step(r.machine, event, r.config)
    r.machine = result.state
    if (r.decisionLimitCycle !== null && r.machine.cycleId !== r.decisionLimitCycle) r.decisionLimitCycle = null
    const saved = await persistMachine(r)
    if (saved === 'superseded') {
      // A newer load of this module owns the file (hot reload): this one stops acting.
      await log('superseded', `load ${r.loadId} stops; ${event.type} not applied further`)
      rt = null
      return
    }
    if (saved === 'failed' && afterPersistFailure(r.machine.phase) === 'abort') {
      for (const effect of result.effects) if (effect.type === 'log') await runEffect(r, effect, newBatch())
      pending.push({ type: 'cancel', now: await now(), reason: 'persist-failed' })
      continue
    }
    const batch = newBatch()
    for (const effect of result.effects) pending.push(...(await runEffect(r, effect, batch)))
    // A pending manual handoff that was dropped (or became GRACE) no longer owns the band.
    if (r.band?.kind === 'manual' && r.machine.manualPending === null && rt === r) setBand(r, r.machine.phase === 'GRACE' ? r.band : null)
  }
  if (rt) await settlePreparation(rt)
}

async function persistMachine(r: Runtime): Promise<'written' | 'superseded' | 'failed'> {
  try {
    const saved = await persistState(storeFsOf(r.host, r.stateDir, r.machine.sessionId), r.stateDir, r.machine, r.persistedSessionId, r.loadId)
    if (saved === 'written') r.persistedSessionId = r.machine.sessionId
    return saved
  } catch (error) {
    await log('persist-failed', `${r.machine.phase}: ${errorText(error)}`)
    return 'failed'
  }
}

async function now(): Promise<number> {
  return rt ? rt.host.now() : 0
}

// ---- effects -----------------------------------------------------------------

type EffectOf<T extends Effect['type']> = Extract<Effect, { type: T }>

/** Reads and parses the template at each cycle (C2); never a hard-coded heading list. */
async function loadTemplate(r: Runtime): Promise<Template | { failure: string }> {
  const text = await readOrNull(r.host, `${r.repoRoot}/${TEMPLATE}`)
  return text === null ? { failure: `template missing at ${r.repoRoot}/${TEMPLATE}` } : parseTemplate(text)
}

/** Composes, writes, re-reads and verifies a brief for the current session (both doors). */
async function writeVerifiedBrief(r: Runtime, template: Template, sections: string, facts: string, at: number, tokens: number, label: string): Promise<{ path: string } | { failure: string }> {
  const time = localTime(at, r.utcOffsetMinutes)
  const header: BriefHeader = {
    session: r.machine.sessionId,
    previous: r.machine.previousSessionId ?? 'none',
    transcript: r.machine.transcriptPath ?? '',
    created: time.iso,
    tokens,
  }
  const text = composeBrief(template, header, sections, facts)
  if (typeof text !== 'string') return text
  // The first free cycle suffix: the skill's snapshot of this run is in the same folder and minute.
  let n = 1
  while (await r.host.exists(`${r.briefDir}/${briefFileName(r.machine.sessionId, time.stamp, n)}`)) n += 1
  const path = `${r.briefDir}/${briefFileName(r.machine.sessionId, time.stamp, n)}`
  try {
    await r.host.write(path, text)
    const reread = await r.host.read(path)
    const verdict = verifyBrief(reread, template)
    if ('failure' in verdict) return { failure: `${path}: ${verdict.failure}` }
    await log('brief-written', `${label} ${path} mode=${verdict.mode} ${reread.length} chars`)
    return { path }
  } catch (error) {
    return { failure: `${path}: ${errorText(error)}` }
  }
}

/** The extractor's Facts markdown (C1), or the reason it failed. `exclude` skips the gating prompt. */
async function runExtractor(r: Runtime, transcriptPath: string, exclude: string | null): Promise<{ markdown: string } | { failure: string }> {
  const run = await r.host.run(extractorArgv(`${r.repoRoot}/${EXTRACTOR}`, transcriptPath, exclude), FACTS_TIMEOUT_MS)
  if (run.exitCode === 0 && run.stdout.startsWith('## Facts from the transcript')) return { markdown: run.stdout }
  return { failure: `extractor exit ${run.exitCode}: ${run.stderr.slice(0, 200)}` }
}

/**
 * The nudge's precompute: the extractor in the background (no model), with the same exclusions the
 * run's brief uses (the run's own `/compact-crafter …` prompt is excluded by prefix either way).
 * Deferred and never awaited by a hook; it writes nothing (the log is in the state folder); a
 * failure only logs, and the brief then reruns the extractor.
 */
function precomputeFacts(r: Runtime, e: EffectOf<'precomputeFacts'>): void {
  const path = r.machine.transcriptPath
  invalidateFacts(r, null)
  const generation = r.factsGeneration
  if (path === null) {
    void log('precompute-skipped', `${e.sessionId} transcript path unknown`)
    return
  }
  r.host.after(0, () => {
    void (async () => {
      try {
        const { size, mtimeMs } = await r.host.stat(path)
        if (r.factsGeneration !== generation) return // a typed prompt or a session change came first
        const result = runExtractor(r, path, HANDOFF_COMMAND).catch((error: unknown): FactsResult => ({ failure: errorText(error) }))
        r.facts = { key: { sessionId: e.sessionId, size, mtimeMs }, path, result }
        const done = await result
        if ('failure' in done) await log('precompute-failed', `${e.sessionId} ${done.failure}`)
        else await log('precompute-done', `${e.sessionId} ${size} bytes, ${done.markdown.length} chars of Facts`)
      } catch (error) {
        await log('precompute-failed', `${e.sessionId} ${errorText(error)}`)
      }
    })()
  })
}

/**
 * Drops the precompute (W2e r2): a typed or Remote Control prompt changes "Last user request", and a
 * session change changes the transcript. A precompute still in flight never stores its result.
 */
function invalidateFacts(r: Runtime, why: string | null): void {
  r.factsGeneration += 1
  if (r.facts !== null && why !== null) void log('facts-invalidated', why)
  r.facts = null
}

/** The automatic run's Facts: the precompute while the transcript grew less than the bound (nudge.ts), else a fresh run. */
async function factsForRun(r: Runtime, transcriptPath: string, exclude: string | null): Promise<FactsResult> {
  const cached = r.facts?.path === transcriptPath ? r.facts : null
  let why: string
  try {
    const decision = decideFactsReuse(cached?.key ?? null, r.machine.sessionId, await r.host.stat(transcriptPath))
    if (decision.isReused) {
      const result = await (cached as NonNullable<Runtime['facts']>).result
      if ('markdown' in result) {
        await log('facts-reused', `grew ${decision.grown} bytes since the precompute`)
        return result
      }
      why = `precompute failed: ${result.failure}`
    } else {
      why = decision.why
    }
  } catch (error) {
    why = `stat failed: ${errorText(error)}`
  }
  await log('facts-rerun', why)
  return runExtractor(r, transcriptPath, exclude)
}

/**
 * handoff_now: check the skill's snapshot, add the mod's own Facts (the gating prompt excluded, so
 * "Last user request" is the request before it), write and verify the brief, and queue it for the
 * end of this turn. The answer is the tool result the model reads. `door` 'auto' is the automatic
 * run's bound turn: the run must be in BRIEFING with no brief yet, and the snapshot must name the
 * current full session id (file name and header) and lie under the brief folder.
 */
async function queueHandoff(r: Runtime, snapshotPath: unknown, turn: TurnInfo, door: 'manual' | 'auto', call: TrackCall): Promise<string> {
  const isFree = door === 'auto' ? r.machine.phase === 'BRIEFING' && r.machine.manualPending === null : r.machine.phase === 'IDLE' && r.machine.manualPending === null
  if (!isFree) return `handoff not queued: a handoff is already in progress (${r.machine.phase})`
  if (typeof snapshotPath !== 'string' || !snapshotPath.startsWith('/')) return 'snapshot invalid: snapshot_path must be an absolute path'
  // The automatic door judges the path by spelling before it opens anything (audit P4: any absolute
  // path was opened first). A link or FIFO already planted at <briefDir>/<sid>-*.md is still opened.
  if (door === 'auto') {
    const wrongPath = checkArmedPath(snapshotPath, r.briefDir, await r.host.sessionId())
    if (wrongPath !== null) {
      await log('handoff-now-invalid', `${snapshotPath}: ${wrongPath}`)
      return `snapshot invalid: ${wrongPath}`
    }
  }
  const snapshot = await readOrNull(r.host, snapshotPath)
  if (snapshot === null) return `snapshot invalid: cannot read ${snapshotPath}`
  const read = await checkReadSnapshot(r, door, snapshotPath, snapshot)
  if ('failure' in read) return read.failure
  const { template, checked } = read
  // TRACK-23, 2026-10-14: a known pending mismatch was reported only after
  // queued acceptance. Return it while the caller can still repair the row.
  const preflight = await preflightPending(r, checked.sections, snapshot, door)
  if (preflight !== null) {
    // TRACK-25: subjects and row notes are untrusted text, so the automatic door logs only counts and open row ids.
    const reason = preflight.logged ?? preflight.reason
    const logged = preflight.rowIds === undefined ? reason : `${reason}; open rows: ${clip(preflight.rowIds.join(', '), 300)}`
    await log(preflight.kind === 'snapshot' ? 'handoff-now-invalid' : 'handoff-now-refused', `${snapshotPath}: ${logged}`)
    return `${preflight.kind === 'snapshot' ? 'snapshot invalid' : 'handoff not queued'}: ${preflight.reason}${preflight.hint === undefined ? '' : `\n${preflight.hint}`}`
  }
  // TRACK-23: a pending /retro approval must be carried, so refuse before queueing when it cannot be.
  const latch = await retroSnapshot(r, r.machine.sessionId)
  if (needsRetroCarry(latch)) {
    const probe = await r.host.run(['bash', retroGatePath(r.home), 'carry', '--check'], RETRO_CARRY_TIMEOUT_MS)
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))
    if (probe.exitCode !== 0) {
      await log('handoff-now-refused', `${snapshotPath}: retro latch cannot be carried (exit ${probe.exitCode}): ${probe.stderr.trim().slice(0, 200)}`)
      return `handoff not queued: a /retro approval is pending and retro-gate.sh cannot carry it (exit ${probe.exitCode})`
    }
  }
  const transcriptPath = r.machine.transcriptPath
  if (transcriptPath === null) return 'handoff not queued: the transcript path is not known yet'
  const facts = door === 'auto' ? await factsForRun(r, transcriptPath, turn.promptText) : await runExtractor(r, transcriptPath, turn.promptText)
  if ('failure' in facts) return `handoff not queued: ${facts.failure}`
  const usage = await r.host.usage()
  const written = await writeVerifiedBrief(r, template, checked.sections, facts.markdown, await now(), usage.context.tokens ?? 0, door)
  if ('failure' in written) return `handoff not queued: the brief failed verification: ${written.failure}`
  const prepared = await prepareForQueue(r, call, door, turn, written.path)
  if (prepared !== null) return `handoff not queued: ${prepared}`
  const paths = markerPaths(r.machine.sessionId)
  const markers: MarkerSnapshot | null =
    paths === null ? null : { project: await readOrNull(r.host, paths.project), verified: await readOrNull(r.host, paths.verified), retro: latch }
  const at = await now()
  if (door === 'auto') {
    // TRACK-25: a concurrent call may have declared a decision since this snapshot's preflight.
    // Recheck with no await before the dispatch, so a "- none" cannot be queued past it.
    const removal = bindDeclared(r, snapshot)
    if (removal !== null) {
      await log('handoff-now-invalid', `${snapshotPath}: ${removal.logged}`)
      return `snapshot invalid: ${removal.answer}`
    }
  }
  await dispatch({ type: 'manualBrief', now: at, path: written.path, turnId: turn.turnId, markers })
  if (r.machine.manualPending?.path !== written.path) return `handoff not queued: the handoff state changed (${r.machine.phase})`
  setBand(r, { kind: 'manual' })
  return `${HANDOFF_NOW_QUEUED}; the brief is ${written.path}`
}

/**
 * The checks of a snapshot that was read: the automatic door's header, the template load and
 * checkSnapshot (injection and section 3 included). TRACK-25, 2026-10-22: on the automatic door
 * any of these failures still binds the snapshot's declared decisions to the run, in one place.
 */
async function checkReadSnapshot(r: Runtime, door: 'manual' | 'auto', path: string, snapshot: string): Promise<{ failure: string } | { template: Template; checked: Exclude<ReturnType<typeof checkSnapshot>, { failure: string }> }> {
  const failed = async (failure: string, logged: string | null) => {
    if (door === 'auto') bindDeclared(r, snapshot)
    if (logged !== null) await log('handoff-now-invalid', `${path}: ${logged}`)
    return { failure }
  }
  if (door === 'auto') {
    const wrong = checkArmedSnapshot(path, snapshot, r.briefDir, await r.host.sessionId())
    if (wrong !== null) return failed(`snapshot invalid: ${wrong}`, wrong)
  }
  const template = await loadTemplate(r)
  if ('failure' in template) return failed(`handoff not queued: ${template.failure}`, null)
  const checked = checkSnapshot(snapshot, template)
  if ('failure' in checked) return failed(`snapshot invalid: ${checked.failure}`, checked.failure)
  return { template, checked }
}

// ---- the band

/** One public observation, shared by preflight and the independent final check. */
async function requestTrackCheckpoint(r: Runtime, source: string): Promise<{ checkpoint: TrackCheckpoint | null } | { failure: string }> {
  const names = (await r.host.listTools()).map(t => t.name)
  if (!names.some(name => name.startsWith('mcp__track__'))) return { checkpoint: null }
  if (!names.includes(CHECKPOINT_TOOL) || !names.includes(RESTORE_TOOL)) return { failure: 'Track does not provide the v1 checkpoint/restore tools' }
  return checkpointOf(await r.host.callTool({ tool: CHECKPOINT_TOOL, expected_session: source }), source)
}

// ---- the mod's own Track preparation step (handoff-gate r3, errata E-H1/E-H2)

/** One Track call, raised from the hook that holds `$` (its calling frame) or through the load's host. */
type TrackCall = (args: ToolCallArgs) => Promise<unknown>

async function callText(call: TrackCall, args: ToolCallArgs): Promise<{ text: string } | { failure: string }> {
  try {
    return answerText((await call(args)) as { result?: unknown; deny?: string; isError?: boolean })
  } catch (error) { return { failure: errorText(error) } }
}

/**
 * Creates this preparation's step after the last stored plan row (Track's after: 'last'; never a plan replacement). Null on success or
 * when Track's step tools are absent; otherwise the failure, kept on the preparation so the key is not retried.
 */
async function createPreparation(r: Runtime, call: TrackCall, route: Preparation['route'], key: string, turnId: string): Promise<string | null> {
  const names = (await r.host.listTools()).map(t => t.name)
  if (!PREPARATION_TOOLS.every(name => names.includes(name))) return null
  const prep: Preparation = { route, key, turnId, session: await r.host.sessionId(), stepId: null, state: 'creating', failure: null }
  r.preparation = prep
  const fail = async (failure: string): Promise<string> => {
    prep.state = 'failed'
    prep.failure = failure
    await log('preparation-failed', `${route} ${key}: ${clip(failure, 200)}`)
    return failure
  }
  const title = preparationTitle(key)
  const created = await callText(call, { tool: STEPS_TOOL, steps: [title], after: 'last' })
  if ('failure' in created) return fail(`track_steps failed: ${created.failure}`)
  const id = createdStepId(created.text, title)
  if (id === null) return fail(`track_steps did not create the step: ${clip(created.text, 160)}`)
  prep.stepId = id
  prep.state = 'open'
  await log('preparation-created', `${route} ${key} ${id} after=last`)
  return null
}

/** Completes the open step on a verified receipt: one terminal update, never on another session's rows. */
async function completePreparation(r: Runtime, call: TrackCall, receipt: string): Promise<string | null> {
  const prep = r.preparation
  if (prep === null || prep.state !== 'open' || prep.stepId === null) return null
  prep.state = 'terminal'
  if (await r.host.sessionId() !== prep.session) {
    await log('preparation-skipped', `${prep.key} ${prep.stepId}: the session changed`)
    return 'the session changed since the step was registered'
  }
  const marked = await callText(call, { tool: MARK_TOOL, id: prep.stepId, status: 'completed', result_text: clip(receipt, 280) })
  const failure = 'failure' in marked ? marked.failure : isMarked(marked.text, prep.stepId, 'completed') ? null : `unexpected answer: ${clip(marked.text, 160)}`
  await log(failure === null ? 'preparation-completed' : 'preparation-failed', `${prep.route} ${prep.key} ${prep.stepId}${failure === null ? '' : `: ${clip(failure, 200)}`}`)
  return failure
}

/**
 * After the machine moved: an automatic step still open when its cycle is no longer BRIEFING is paused, once.
 * Raised through the load's host, so a call from a hook other than the guard reaches the guard, which admits
 * exactly this recorded call (E-H1).
 */
async function settlePreparation(r: Runtime): Promise<void> {
  const prep = r.preparation
  if (prep === null || prep.state !== 'open' || prep.stepId === null) return
  if (prep.route === 'auto' && r.machine.phase === 'BRIEFING' && r.machine.cycleId === prep.key) return
  prep.state = 'terminal'
  if (await r.host.sessionId() !== prep.session) {
    await log('preparation-skipped', `${prep.key} ${prep.stepId}: the session changed`)
    return
  }
  const args = { tool: MARK_TOOL, id: prep.stepId, status: 'paused', note: `context-handoff: handoff cycle ${prep.key} was cancelled before its snapshot was queued; the handoff did not run.` }
  const own = { tool: MARK_TOOL, key: argumentsKey(args) }
  r.ownTrackCalls.push(own)
  try {
    const marked = await callText(next => r.host.callTool(next), args)
    const failure = 'failure' in marked ? marked.failure : isMarked(marked.text, prep.stepId, 'paused') ? null : `unexpected answer: ${clip(marked.text, 160)}`
    await log(failure === null ? 'preparation-paused' : 'preparation-failed', `${prep.route} ${prep.key} ${prep.stepId}${failure === null ? '' : `: ${clip(failure, 200)}`}`)
  } finally {
    r.ownTrackCalls = r.ownTrackCalls.filter(call => call !== own)
  }
}

/** The guard's own-origin branch: exactly one recorded call of the mod's own, by tool and arguments. */
function takeOwnTrackCall(r: Runtime, call: Record<string, unknown>): boolean {
  if (call.tool !== STEPS_TOOL && call.tool !== MARK_TOOL) return false
  const key = argumentsKey(call)
  const index = r.ownTrackCalls.findIndex(own => own.tool === call.tool && own.key === key)
  if (index < 0) return false
  r.ownTrackCalls.splice(index, 1)
  return true
}

/** Automatic route: the first permitted snapshot Write of the cycle registers the step. Null lets the Write run. */
async function registerAtWrite(r: Runtime, call: TrackCall, cycleId: string, turnId: string): Promise<string | null> {
  const prep = r.preparation
  if (prep !== null && prep.route === 'auto' && prep.key === cycleId) return prep.state === 'failed' ? prep.failure : null
  return createPreparation(r, call, 'auto', cycleId, turnId)
}

/** handoff_now, after the brief is written and verified and before the queue: the step exists and is completed. */
async function prepareForQueue(r: Runtime, call: TrackCall, door: 'manual' | 'auto', turn: TurnInfo, briefPath: string): Promise<string | null> {
  const prep = r.preparation
  if (door === 'auto') {
    const cycleId = r.machine.cycleId
    if (cycleId === null) return null
    if (prep !== null && prep.route === 'auto' && prep.key === cycleId) {
      if (prep.state === 'failed') return `the Track preparation step could not be registered: ${prep.failure}`
    } else {
      const created = await createPreparation(r, call, 'auto', cycleId, turn.turnId)
      if (created !== null) return `the Track preparation step could not be registered: ${created}`
    }
  } else {
    r.manualPreparations += 1
    const created = await createPreparation(r, call, 'manual', `manual-${turn.turnId}-${r.manualPreparations}`, turn.turnId)
    if (created !== null) return `the Track preparation step could not be registered: ${created}`
  }
  const done = await completePreparation(r, call, `snapshot verified and brief written (${briefPath}); queued for this turn's end, the handoff has not run yet`)
  return done === null ? null : `the Track preparation step could not be completed: ${done}`
}

/**
 * TRACK-25, 2026-10-17: an automatic run rewrote a declared decision to "- none" and cleared.
 * 2026-10-22: every snapshot the automatic door read binds its declarations, accepted or refused.
 * Compares `text` with the run's record first and returns the refusal when it drops a decision or
 * a pending line; then the record becomes the union of both, so it only grows. `answer` may quote
 * the subjects (JSON); `logged` only counts them.
 */
function bindDeclared(r: Runtime, text: string): { answer: string; logged: string } | null {
  const cycleId = r.machine.cycleId
  // BRIEFING always binds a cycle; without one the earlier decisions cannot be found, so refuse.
  if (cycleId === null) {
    const unbound = 'pending: no automatic cycle is bound, so declared decisions cannot be checked'
    return { answer: unbound, logged: unbound }
  }
  const earlier = r.runDeclared?.cycleId === cycleId ? r.runDeclared : { records: [], lines: 0 }
  // Subjects bind loosely (any pending-looking line); only section 3's strict lines keep (S1, S1c).
  // Both sides of the line count use section 3, so a prose "- pending:" bullet elsewhere cannot make
  // a snapshot refuse itself at the pre-dispatch recheck; the stored side also counts near-miss
  // markers there (T1b).
  const bound = { records: declaredRecords(text), lines: sectionThreePendingLines(text) }
  const kept = { records: strictRecords(text), lines: strictPendingLines(text) }
  r.runDeclared = { cycleId, records: unionDeclared(earlier.records, bound.records), lines: Math.max(earlier.lines, bound.lines) }
  const answer = declaredRemoval(earlier.records, kept.records, { earlier: earlier.lines, current: kept.lines })
  if (answer === null) return null
  const count = Math.max(removedDecisions(earlier.records, kept.records).length, earlier.lines - kept.lines)
  return { answer, logged: `pending: ${count} declared decision${count === 1 ? '' : 's'} removed in this run` }
}

/** `logged` replaces `reason` in handoff.log when the reason quotes untrusted text. */
type Preflight = { kind: 'snapshot' | 'handoff'; reason: string; logged?: string; hint?: string; rowIds?: string[] }

/** `snapshot` is the text that was read: the automatic door binds every pending-looking line of it, in any section. */
async function preflightPending(r: Runtime, sections: string, snapshot: string, door: 'manual' | 'auto'): Promise<Preflight | null> {
  const pending = pendingItems(sections)
  if ('failure' in pending) return { kind: 'snapshot', reason: pending.failure }
  if (door === 'auto') {
    const removal = bindDeclared(r, snapshot)
    if (removal !== null) return { kind: 'snapshot', reason: removal.answer, logged: removal.logged }
  }
  if (pending.items.length === 0) return null
  const source = r.machine.sessionId
  try {
    const result = await requestTrackCheckpoint(r, source)
    if ('failure' in result) return { kind: 'handoff', reason: `Track preflight failed: ${result.failure}` }
    if (rt !== r || r.machine.sessionId !== source || await r.host.sessionId() !== source) return { kind: 'handoff', reason: 'preflight session changed' }
    const isNotesOnly = door === 'auto' && r.decisionLimitCycle !== null && r.decisionLimitCycle === r.machine.cycleId
    const covered = coveredItems(pending.items, isNotesOnly)
    const mismatch = pendingCoverage(covered, result.checkpoint, door)
    if (mismatch === null) return null
    if (door === 'manual') return { kind: 'snapshot', reason: mismatch }
    // The reason quotes a declared subject; the automatic door's log gets only counts and row ids.
    const total = covered.length
    const logged = `pending: ${uncoveredCount(covered, result.checkpoint)} of ${total} declared record${total === 1 ? '' : 's'} without a matching Track row`
    const hint = openRowsHint(result.checkpoint)
    if (hint === '') return { kind: 'snapshot', reason: mismatch, logged }
    return { kind: 'snapshot', reason: mismatch, logged, hint, rowIds: openDecisionRows(result.checkpoint).map(row => row.id) }
  } catch (error) { return { kind: 'handoff', reason: `Track preflight failed: ${errorText(error)}` } }
}

/** Only the public text receipt is retained; Track owns all ledger storage. */
async function checkpointTrack(r: Runtime, cycleId: string): Promise<string | null> {
  const source = r.machine.sessionId
  const path = r.machine.briefPath
  if (path === null) return 'verified brief is missing'
  try {
    let checkpoint: TrackCheckpoint | null = null
    if (r.checkpointAttempts?.cycleId !== cycleId) r.checkpointAttempts = { cycleId, used: 0 }
    let failure: string | null = 'no successful checkpoint receipt'
    while (r.checkpointAttempts.used < 2) {
      r.checkpointAttempts.used++
      try {
        const result = await requestTrackCheckpoint(r, source)
        if ('checkpoint' in result) { checkpoint = result.checkpoint; failure = null; break }
        failure = result.failure
      } catch (error) { failure = errorText(error) }
      if (rt !== r || r.machine.phase !== 'CLEARING' || r.machine.cycleId !== cycleId) return 'checkpoint cycle changed'
    }
    if (failure !== null) return failure
    if (rt !== r || r.machine.phase !== 'CLEARING' || r.machine.cycleId !== cycleId || await r.host.sessionId() !== source) return 'checkpoint session or cycle changed'
    // CC-181: the brief may predate new status/blocker writes. Its declared
    // references must match this exact final public checkpoint before clear.
    const brief = await r.host.read(path)
    const template = await loadTemplate(r)
    if ('failure' in template) return template.failure
    const verified = verifyBrief(brief, template)
    if ('failure' in verified) return verified.failure
    if (!brief.split('\n').slice(0, 15).includes(`session: ${source}`)) return 'pending: brief source session does not match the checkpoint'
    const pending = pendingItems(brief)
    if ('failure' in pending) return pending.failure
    const coverageFailure = pendingCoverage(coveredItems(pending.items, r.decisionLimitCycle === cycleId), checkpoint)
    if (coverageFailure !== null) return coverageFailure
    const metadata = JSON.stringify({ v: 1, cycle_id: cycleId, source_session: source, checkpoint })
    await r.host.write(`${path}.track.json`, metadata)
    if (await r.host.read(`${path}.track.json`) !== metadata) return 'checkpoint receipt read-back did not match'
    r.trackCheckpoint = { cycleId, checkpoint }
    await log('track-checkpoint', `${cycleId} ${checkpoint === null ? 'absent' : `revision=${checkpoint.revision} checksum=${checkpoint.checksum}`}`)
    return null
  } catch (error) { return errorText(error) }
}

async function restoreTrack(r: Runtime, cycleId: string): Promise<string | null> {
  if (r.restoredCycle === cycleId) return null
  const source = r.machine.clearingFrom ?? r.machine.previousSessionId
  const destination = r.machine.sessionId
  const path = r.machine.briefPath
  if (source === null || path === null) return 'source session or verified brief is missing'
  try {
    const text = await readOrNull(r.host, `${path}.track.json`)
    if (text === null) {
      if (!(await r.host.listTools()).some(t => t.name.startsWith('mcp__track__'))) return null
      return 'checkpoint receipt is missing; restoration was not verified'
    }
    const metadata = JSON.parse(text) as { v?: unknown; cycle_id?: unknown; source_session?: unknown; checkpoint?: unknown }
    if (metadata.v !== 1 || metadata.cycle_id !== cycleId || metadata.source_session !== source) return 'checkpoint metadata does not match this handoff'
    if (metadata.checkpoint === null) return null
    const parsed = checkpointOf({ result: JSON.stringify(metadata.checkpoint) }, source)
    if ('failure' in parsed) return parsed.failure
    const args = { tool: RESTORE_TOOL, from_session: source, expected_checkpoint: parsed.checkpoint }
    const result = restorationOf(await r.host.callTool(args), parsed.checkpoint, destination)
    if ('failure' in result) return `${result.failure}; call ${RESTORE_TOOL} with ${JSON.stringify({ from_session: source, expected_checkpoint: parsed.checkpoint })} and require a matching successful receipt before continuing`
    if (!(await seedTargetMatches(r, cycleId))) return 'restore session or cycle changed'
    r.restoredCycle = cycleId
    r.restoredReceipt = JSON.stringify(result.restored)
    await log('track-restored', `${cycleId} destination=${destination} revision=${result.restored.revision} applied_checksum=${result.restored.applied_checksum}`)
    return null
  } catch (error) { return `${errorText(error)}; restore_tracker must succeed before continuation` }
}

function runClear(r: Runtime, e: EffectOf<'runClear'>): void {
  r.host.after(0, () => {
    void (async () => {
      try {
        if (rt !== r || r.machine.phase !== 'CLEARING' || r.machine.cycleId !== e.cycleId) return
        const generation = r.activityGeneration
        const record = await relayObservation(r)
        const activity = record.stop
        if (generation !== r.activityGeneration || activity === null || activity.backgroundTasks !== 0 || activity.sessionCrons !== 0) {
          const isUnknown = activity === null || activity.backgroundTasks === null || activity.sessionCrons === null || generation !== r.activityGeneration
          const reason = isUnknown ? 'activity-unknown' : `background work (${activity.backgroundTasks} tasks, ${activity.sessionCrons} crons)`
          await dispatch({ type: 'cancel', now: await now(), reason: isUnknown ? 'activity-unknown' : 'activity-busy' })
          await pinStatus(r, `context-handoff: ${reason}; context retained, clear was not issued`)
          return
        }
        // Validate declared coverage at the final public Track checkpoint.
        // Keep the generation captured before it: intervening native activity
        // must invalidate this attempt, even if it occurs during checkpoint I/O.
        const checkpointFailure = await checkpointTrack(r, e.cycleId)
        if (rt !== r || r.machine.phase !== 'CLEARING' || r.machine.cycleId !== e.cycleId) return
        if (checkpointFailure !== null) {
          await dispatch({ type: 'cancel', now: await now(), reason: 'checkpoint-failed' })
          await pinStatus(r, `context-handoff: Track checkpoint failed (${checkpointFailure}); context retained, clear was not issued`)
          return
        }
        // Check reviews, draft and kill switch after checkpoint I/O. They can
        // change without a native activity event while the checkpoint waits.
        const open = confirmedOpen(await readReviews(r, r.machine.sessionId, 'in-cycle'))
        if (open > 0) {
          await dispatch({ type: 'reviewOpen', cycleId: e.cycleId, now: await now(), count: open, at: 'clear' })
          return
        }
        const draft = (await r.host.readPrompt()).text
        const kill = await isKillSwitchOn(r)
        if (draft.trim() !== '' || r.isTypedDuringTurn || r.machine.isSuperseded || kill) {
          const reason = kill ? 'kill-switch' : draft.trim() !== '' ? 'draft-in-prompt-box' : 'pending-typed-prompt'
          await dispatch({ type: 'cancel', now: await now(), reason: 'pre-clear-guard' })
          await pinStatus(r, `context-handoff: ${reason}; context retained, clear was not issued`)
          return
        }
        // Recheck after the review read: a native event may have invalidated this observation.
        if (rt !== r || r.machine.phase !== 'CLEARING' || r.machine.cycleId !== e.cycleId) return
        if (generation !== r.activityGeneration) {
          await dispatch({ type: 'cancel', now: await now(), reason: 'activity-unknown' })
          return
        }
        await r.host.runCommand('clear')
        await log('clear-run', `${e.cycleId} command.run(clear) resolved`)
        await dispatch({ type: 'clearResult', cycleId: e.cycleId, now: await now() })
      } catch (error) {
        await dispatch({ type: 'clearResult', cycleId: e.cycleId, now: await now(), failure: errorText(error) })
      }
    })()
  })
}

/** The args the automatic run passes to the skill (W5's skill reads `session=`). */
function autoRunArgs(cycleId: string, sessionId: string): string {
  return `automatic-run cycle=${cycleId} session=${sessionId}`
}

/**
 * The automatic run: /compact-crafter as if typed, through $.command.run (d.ts: "queued and run once
 * the session is idle", origin `{ kind: 'plugin', name }`, rejected inside a hook the turn is waiting
 * on), so it is deferred with clock.after(0) like the clear. Probe build: only logged, nothing binds
 * to it yet.
 */
function startAutoRun(r: Runtime, e: EffectOf<'startAutoRun'>): void {
  const args = autoRunArgs(e.cycleId, r.machine.sessionId)
  r.host.after(0, () => {
    void (async () => {
      await log('auto-run-called', `${e.cycleId} command.run(${SKILL_COMMAND}) args=${JSON.stringify(args)}`)
      // The binding window opens here (live: the call resolves at dispatch, before the run's turn.start).
      await dispatch({ type: 'autoRunCalled', cycleId: e.cycleId, now: await now() })
      if (!isRunCallable(r.machine, e.cycleId)) {
        // The cycle ended before this deferred call (W2e r2: a later Stop record reported background work).
        await log('auto-run-skipped', `${e.cycleId} the cycle ended before the call; command.run not issued`)
        return
      }
      r.runToolCalls = 0
      r.runDeclared = null
      if (!(await writeOpenRows(r, e.cycleId))) {
        await log('auto-run-skipped', `${e.cycleId} the runtime, session or cycle changed while the open rows were read; command.run not issued`)
        return
      }
      try {
        const value = await r.host.runCommand(SKILL_COMMAND, args)
        await log('auto-run-resolved', `${e.cycleId} value=${clip(JSON.stringify(value) ?? 'undefined', 200)}`)
      } catch (error) {
        await log('auto-run-rejected', `${e.cycleId} ${clip(errorText(error), 300)}`)
        await dispatch({ type: 'autoRunFailed', cycleId: e.cycleId, now: await now(), failure: `command.run rejected: ${clip(errorText(error), 200)}` })
      }
    })()
  })
}

/** plan:111: where the automatic run reads this session's open decision rows (allowlist: `<briefDir>/<sid>-*`). */
function openRowsPath(briefDir: string, sessionId: string): string {
  return `${briefDir}/${sessionId}-open-rows.json`
}

/**
 * plan:111: reads the open waiting/paused rows and writes them, complete or typed incomplete, before the
 * skill starts. The checkpoint awaits host calls, so the write is fenced to this runtime, session and
 * cycle (as preflightPending is); false means the fence failed and nothing was written. A failed
 * checkpoint or write never stops the run: the record says incomplete, or the skill finds no record.
 */
async function writeOpenRows(r: Runtime, cycleId: string): Promise<boolean> {
  const source = r.machine.sessionId
  let result: { checkpoint: TrackCheckpoint | null } | { failure: string }
  try { result = await requestTrackCheckpoint(r, source) } catch (error) { result = { failure: errorText(error) } }
  try {
    if (rt !== r || r.machine.sessionId !== source || await r.host.sessionId() !== source || !isRunCallable(r.machine, cycleId)) return false
  } catch { return false }
  const record = openRowsRecord(result, cycleId, source)
  try {
    await r.host.write(openRowsPath(r.briefDir, source), JSON.stringify(record))
    await log('open-rows-written', `${cycleId} complete=${record.complete} rows=${record.rows.length}`)
  } catch (error) {
    await log('open-rows-failed', `${cycleId} ${clip(errorText(error), 200)}`)
  }
  return true
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Log whether the command list holds the skill and identify its source. */
async function logCommandList(r: Runtime): Promise<void> {
  try {
    const found = (await r.host.listCommands()).filter(c => c.name === SKILL_COMMAND)
    const where = found.map(c => `${c.source}${c.plugin ? `:${c.plugin}` : ''}`).join(',')
    await log('command-list', `${SKILL_COMMAND}=${found.length > 0 ? 'yes' : 'no'}${where ? ` source=${where}` : ''}`)
  } catch (error) {
    await log('command-list', `failed: ${clip(errorText(error), 200)}`)
  }
}

/** W8 E: removes session files untouched for 30 days, before the load scans the folder. Never throws. */
async function pruneSessions(r: Runtime, sessionId: string, at: number): Promise<void> {
  const dir = `${r.stateDir}/sessions`
  try {
    if (!(await r.host.exists(dir))) return
    const stale = staleSessionFiles(await r.host.list(dir), at, sessionFile(r.stateDir, sessionId)?.split('/').pop() ?? '')
    if (stale.length === 0) return
    const run = await r.host.run(['rm', '-f', '--', ...stale.map(name => `${dir}/${name}`)], 5_000)
    if (run.exitCode === 0) await log('sessions-pruned', `${stale.length} files untouched for 30 days passed to rm -f`)
    else await log('sessions-prune-failed', `rm exit ${run.exitCode}: ${clip(run.stderr, 200)}`)
  } catch (error) {
    await log('sessions-prune-failed', clip(errorText(error), 300))
  }
}

function pollNewId(r: Runtime, e: EffectOf<'pollNewId'>): void {
  if (r.pollingCycle === e.cycleId) return
  r.pollingCycle = e.cycleId
  const host = { now, sleep: (ms: number) => r.host.sleep(ms), sessionId: () => r.host.sessionId() }
  // Detached: nothing awaits this, so every outcome is dispatched or logged here (log never rejects).
  void pollForNewId(host, e.oldSessionId, e.withinMs)
    .then(async result => {
      if ('failure' in result) {
        await log('poll-new-id-failed', `${e.cycleId} ${clip(result.failure, 300)}`)
        await dispatch({ type: 'newIdResolved', cycleId: e.cycleId, now: await now(), sessionId: null, failure: clip(result.failure, 200) })
        return
      }
      await dispatch({ type: 'newIdResolved', cycleId: e.cycleId, now: await now(), sessionId: result.sessionId })
    })
    .catch((error: unknown) => log('poll-new-id-stopped', `${e.cycleId} ${clip(errorText(error), 300)}; the clear deadline or the next load's recovery ends the cycle`))
}

/** TRACK-23 v3 (E1): one session's latch files, or null for an unsafe id. */
async function retroFiles(r: Runtime, sessionId: string, carriedTo: string | null): Promise<RetroLatchFiles | null> {
  // v4 (G1d): carried-<id> counts only as a regular file that is not a link, as in the gate.
  // v5 (G4b): and only when it names carriedTo, the session reading it; null reads it as not carried.
  return readRetroLatchFiles(r.host, r.home, sessionId, carriedTo)
}

/** TRACK-23: the /retro latch this handoff carries, read when the brief is queued: this session's own, else its previous session's (v3, E1). */
async function retroSnapshot(r: Runtime, sessionId: string): Promise<RetroLatchSnapshot | null> {
  const own = await retroFiles(r, sessionId, null)
  if (own === null) return null
  const previousId = r.machine.previousSessionId
  // v5 (G4b): carried-<previous> releases the previous latch only when it names this session.
  const previous = previousId === null ? null : await retroFiles(r, previousId, sessionId)
  return retroLatchSource(sessionId, own, previousId, previous)
}

/** TRACK-23: carry an unapproved /retro latch to the new id. Null means carried, released or not needed. */
async function carryRetroLatch(r: Runtime, cycleId: string, fromSessionId: string, toSessionId: string, retro: RetroLatchSnapshot | null | undefined): Promise<string | null> {
  if (!needsRetroCarry(retro)) return null
  // v3 (E1): copy from the session that owns the latch, which may be the cleared session's predecessor.
  const sourceId = retro?.sourceId ?? fromSessionId
  const argv = retroCarryArgv(r.home, sourceId, toSessionId)
  const source = retroPaths(r.home, sourceId)
  if (argv === null || source === null) return 'unsafe session id for the retro latch'
  try {
    const run = await r.host.run(argv, RETRO_CARRY_TIMEOUT_MS)
    // Exit 6 says active-<from> is gone; the mod rechecks the same file before it trusts that.
    const isSourceStillActive = run.exitCode === 6 && (await r.host.exists(source.active))
    const outcome = classifyRetroCarry(run.exitCode, run.stderr, isSourceStillActive)
    if ('carried' in outcome) {
      await log('retro-latch-carried', `${cycleId} ${sourceId} -> ${toSessionId}`)
      return null
    }
    if ('skipped' in outcome) {
      await log('retro-latch-skipped', `${cycleId} ${outcome.skipped}`)
      return null
    }
    return outcome.failure
  } catch (error) {
    return `retro-gate.sh carry did not run: ${errorText(error)}`
  }
}

async function carryMarkers(r: Runtime, e: EffectOf<'carryMarkers'>): Promise<MachineEvent[]> {
  const at = await now()
  const sessionEnv = await r.host.sessionEnvId()
  await log('ids-after-clear', `${e.cycleId} from=${e.fromSessionId} to=${e.toSessionId} CLAUDE_SESSION_ID=${sessionEnv ?? 'unset'}`)
  // The latch goes first and independently: a skipped project carry must not skip it.
  const retroFailure = await carryRetroLatch(r, e.cycleId, e.fromSessionId, e.toSessionId, e.snapshot?.retro)
  const retro = retroFailure === null ? {} : { retroFailure }
  const decision = decideCarry(e.snapshot)
  if ('skip' in decision) {
    await log('carry-skipped', `${e.cycleId} ${decision.skip}`)
    return [{ type: 'carryDone', cycleId: e.cycleId, now: at, ...retro }]
  }
  const writes = carryWrites(e.toSessionId, decision.project)
  if (writes === null) return [{ type: 'carryDone', cycleId: e.cycleId, now: at, failure: 'unsafe new session id', ...retro }]
  try {
    for (const w of writes) await r.host.write(w.path, w.text)
    await log('carried', `${e.cycleId} ${decision.project} -> ${writes.map(w => w.path).join(', ')}`)
    return [{ type: 'carryDone', cycleId: e.cycleId, now: await now(), ...retro }]
  } catch (error) {
    return [{ type: 'carryDone', cycleId: e.cycleId, now: await now(), failure: errorText(error), ...retro }]
  }
}

/** TRACK-23 v3 (E4): a late clear carries the cleared session's latch; a failure pins the CARRYING path's notice. */
async function carryLateRetroLatch(r: Runtime, e: EffectOf<'carryRetroLatch'>): Promise<void> {
  const failure = await carryRetroLatch(r, 'late-clear', e.fromSessionId, e.toSessionId, e.retro)
  if (failure === null) return
  await log('retro-latch-failed', `late-clear ${failure}`)
  const brief = e.briefPath === null ? '' : `; the brief is ${e.briefPath}`
  await pinStatus(r, `context-handoff: retro latch not carried (${failure}); continuation held, approve or close the /retro by hand${brief}`)
}

function submitSeed(r: Runtime, e: EffectOf<'submitSeed'>): void {
  const name = e.briefPath.split('/').pop() as string
  const seed = { cycleId: e.cycleId, text: seedText(name), note: seedNote(e.briefPath), via: e.via }
  r.pendingSeed = seed
  r.seedTurn = { text: seed.text, turnId: null, isCalled: false }
  if (e.via === 'initial' && r.isInSessionStart && r.trackCheckpoint?.checkpoint === null && r.machine.responseReplay === null) {
    r.initialSeed = seed.text // one line, no path (seed-words rule); the note cannot ride on initialUserMessage
    return
  }
  r.host.after(0, () => void deliverSeed(r, seed))
}

/**
 * The brief path goes in a model-only user row ($.session.append, which the
 * prompt hooks never see), then the one-line seed. A plugin's own submit does
 * not pass through its own prompt.submit hook (seen under `claude plugin test`),
 * so delivery is read from the submit call itself: it resolves as the seed's
 * turn starts, or with `drop` when a hook refused it (the SEEDING timeout then strands it).
 */
async function deliverSeed(r: Runtime, seed: { cycleId: string; text: string; note: string }): Promise<void> {
  if (!(await seedTargetMatches(r, seed.cycleId))) return
  await replayResponse(r)
  if (!(await seedTargetMatches(r, seed.cycleId))) return
  const restoreFailure = await restoreTrack(r, seed.cycleId)
  if (!(await seedTargetMatches(r, seed.cycleId))) return
  if (restoreFailure !== null) {
    r.pendingSeed = null
    r.seedTurn = null
    await dispatch({ type: 'trackRestoreFailed', cycleId: seed.cycleId, now: await now(), failure: restoreFailure })
    return
  }
  if (r.restoredCycle === seed.cycleId && r.restoredReceipt !== null) {
    seed.note += ` Verified Track restore receipt: ${r.restoredReceipt}`
  } else {
    seed.note += ' Track absent; pending items are notes only, with no verified Track coverage.'
  }
  if (r.decisionLimitCycle === seed.cycleId) {
    seed.note += ` A pending item with a null track_id has ${NOTES_ONLY}; no Track receipt covers it, so ask the person about it again.`
  }
  if (r.machine.responseReplay?.status === 'shown') {
    seed.note += ' The previous final response was already displayed verbatim to the user. Do not print it again.'
  } else if (r.machine.responseReplay?.status === 'attempted') {
    seed.note += ' Previous-response display is uncertain. Do not repeat it automatically.'
  }
  // Hold the receipt object across turn.complete, which clears the live turn binding.
  const receipt = r.seedTurn
  try {
    const outcome = appendOutcome(await r.host.appendNote(seed.note))
    if ('denied' in outcome) await log('seed-note-denied', `${seed.cycleId} ${outcome.denied}`)
    else await log('seed-note', `${seed.cycleId} brief path appended as a model-only row ${outcome.uuid}`)
  } catch (error) {
    await log('seed-note-failed', `${seed.cycleId} ${errorText(error)}`)
  }
  // Appending the note can await another hook. The session may change during
  // that wait; a note receipt is not authority to submit into the old session.
  if (!(await seedTargetMatches(r, seed.cycleId))) return
  try {
    const entered = await r.host.submit(seed.text)
    if (entered.drop !== undefined) {
      await log('seed-dropped', `${seed.cycleId} ${entered.drop}`)
      if (r.seedTurn?.text === seed.text) r.seedTurn = null
      await dispatch({ type: 'seedFailed', cycleId: seed.cycleId, now: await now(), failure: entered.drop })
      return
    }
    await log('seed-entered', `${seed.cycleId} text=${JSON.stringify(seed.text)}`)
    if (r.pendingSeed?.cycleId === seed.cycleId) r.pendingSeed = null
    await dispatch({ type: 'seedDelivered', cycleId: seed.cycleId, now: await now() })
  } catch (error) {
    await log('seed-submit-failed', `${seed.cycleId} ${errorText(error)}`)
    // A native turn.start is an independent delivery receipt. An exception
    // after that receipt must not put the seed back in the draft for a retry.
    const reconcile = async () => {
      if (!(await seedTargetMatches(r, seed.cycleId))) return
      if (receipt?.text === seed.text && receipt.turnId !== null) {
        await log('seed-reconciled', `${seed.cycleId} observed seed turn ${receipt.turnId}`)
        r.pendingSeed = null
        await dispatch({ type: 'seedDelivered', cycleId: seed.cycleId, now: await now() })
      } else {
        r.pendingSeed = null
        r.seedTurn = null
        await dispatch({ type: 'seedUnknown', cycleId: seed.cycleId, now: await now(), failure: errorText(error) })
      }
    }
    // A native turn receipt can arrive after the submit transport throws. Give it
    // one bounded reconciliation window; absence is uncertainty, never failure proof.
    if (receipt?.turnId !== null && receipt?.turnId !== undefined) await reconcile()
    else r.host.after(1_000, () => void reconcile().catch(failure => log('seed-reconcile-failed', errorText(failure))))
  }
}

function replayResponse(r: Runtime): Promise<void> {
  return r.replayInFlight ??= appendResponseOnce(r).finally(() => { r.replayInFlight = null })
}

/** Claim durably before append: another callback or load must never retry an uncertain display. */
async function appendResponseOnce(r: Runtime): Promise<void> {
  const replay = r.machine.responseReplay
  if (replay?.status !== 'pending' || replay.destinationSession !== r.machine.sessionId) return
  const attemptId = crypto.randomUUID()
  const current = async () => {
    const sessionId = await r.host.sessionId()
    return rt === r && r.machine.responseReplay?.attemptId === attemptId &&
      r.machine.sessionId === sessionId && replay.destinationSession === sessionId
  }
  try {
    await dispatch({ type: 'responseReplayAttempt', cycleId: replay.cycleId, destinationSession: replay.destinationSession, attemptId, now: await now() })
    if (!(await current())) return
    const path = sessionFile(r.stateDir, replay.destinationSession)
    const durable = path === null ? null : parseState(await r.host.read(path))
    if (durable?.loadId !== r.loadId || durable.responseReplay?.attemptId !== attemptId || durable.responseReplay.status !== 'attempted') {
      await log('response-replay-unsaved', `${replay.cycleId} display intent was not saved; no append`)
      await pinStatus(r, 'context-handoff: the previous response could not be redisplayed because its display intent was not saved')
      return
    }
    if (!(await current())) return
    const text = responseNotice(replay.response)
    const receipt = responseReceiptOf(await r.host.appendNotice(text), text)
    if (!(await current())) return
    if ('unknown' in receipt) throw new Error(receipt.unknown)
    if ('uuid' in receipt) {
      // A stored informational notice is hidden in the normal terminal. Place
      // a real display row; ui.log would truncate replies at 2000 characters.
      const placed = await r.host.placeResponse(responseRowId(attemptId))
      if (!(await current())) return
      if (!placed.isPlaced) throw new Error(`previous response row was not placed: ${placed.reason}`)
    }
    await dispatch({ type: 'responseReplayReceipt', cycleId: replay.cycleId, destinationSession: replay.destinationSession,
      attemptId, uuid: 'uuid' in receipt ? receipt.uuid : null, now: await now() })
    if ('refused' in receipt) {
      await log('response-replay-refused', `${replay.cycleId} ${receipt.refused}`)
      await pinStatus(r, `context-handoff: previous response display refused (${receipt.refused}); its full text remains in the handoff state`)
    } else {
      await log('response-replayed', `${replay.cycleId} destination=${replay.destinationSession} uuid=${receipt.uuid}`)
    }
  } catch (error) {
    await log('response-replay-unknown', `${replay.cycleId} ${errorText(error)}`)
    if (rt === r) await pinStatus(r, 'context-handoff: previous response display is uncertain; it will not be repeated automatically')
  }
}

async function seedTargetMatches(r: Runtime, cycleId: string): Promise<boolean> {
  if (rt !== r || r.machine.phase !== 'SEEDING' || r.machine.cycleId !== cycleId) return false
  const sessionId = await r.host.sessionId()
  if (rt !== r || r.machine.phase !== 'SEEDING' || r.machine.cycleId !== cycleId) return false
  if (sessionId === r.machine.sessionId && sessionId !== r.machine.clearingFrom) return true
  await log('seed-session-changed', `${cycleId} expected ${r.machine.sessionId}, observed ${sessionId}; no submit`)
  await dispatch({ type: 'sessionStart', now: await now(), sessionId, source: 'seed-check' })
  return false
}

async function fillSeed(r: Runtime, e: EffectOf<'fillSeed'>, batch: Batch): Promise<void> {
  const name = e.briefPath.split('/').pop() as string
  try {
    const filled = await r.host.fill(`${seedText(name)} ${seedNote(e.briefPath)}`)
    batch.isFilled = filled.isFilled
    await log('seed-filled', `isFilled=${filled.isFilled}`)
  } catch (error) {
    // A rejected fill must not lose the notice that follows it in the same step.
    batch.isFilled = false
    await log('seed-fill-failed', errorText(error))
  }
}

function setBand(r: Runtime, band: Band): void {
  r.band = band
  r.host.invalidate()
}

/**
 * What the effects of one step share while they run: the fillSeed outcome its pinNotice reads
 * (`ifUnfilled`). Per batch, so a notice from another step or from the load's effects never reads it.
 */
type Batch = { isFilled: boolean | null }

function newBatch(): Batch {
  return { isFilled: null }
}

type EffectRunner<T extends Effect['type']> = (r: Runtime, effect: EffectOf<T>, batch: Batch) => Promise<MachineEvent[]> | MachineEvent[]

const none = (): MachineEvent[] => []

const EFFECT_RUNNERS: { [T in Effect['type']]: EffectRunner<T> } = {
  log: async (_r, e) => (await log(e.event, e.detail), []),
  startAutoRun: (r, e) => {
    r.decisionLimitCycle = e.decisionLimitReached === true ? e.cycleId : null
    startAutoRun(r, e)
    return none()
  },
  showGrace: (r, e) => (setBand(r, { kind: 'grace', deadline: e.deadline }), none()),
  hideBand: r => (setBand(r, null), none()),
  runClear: (r, e) => (runClear(r, e), none()),
  pollNewId: (r, e) => (pollNewId(r, e), none()),
  carryMarkers: carryMarkers,
  submitSeed: (r, e) => (submitSeed(r, e), none()),
  fillSeed: async (r, e, batch) => (await fillSeed(r, e, batch), []),
  carryRetroLatch: async (r, e) => (await carryLateRetroLatch(r, e), []),
  nudge: (r, e) => {
    r.pendingNudge = e.text
    if (e.rearmedWindow !== undefined) r.rearmedWindow = e.rearmedWindow
    return none()
  },
  backgroundReminder: (r, e) => {
    r.pendingNudge = queueReminder(r.pendingNudge, e.text)
    return none()
  },
  precomputeFacts: (r, e) => (precomputeFacts(r, e), none()),
  pinNotice: async (r, e, batch) => {
    await pinStatus(r, e.ifUnfilled !== undefined && batch.isFilled === false ? e.ifUnfilled : e.text)
    return []
  },
  reviewHeld: async (r, e) => {
    const text = r.reviews.held(r.machine.sessionId, e.reason, reviewStorePath(r.reviewStoreDir))
    if (text !== null) await pinStatus(r, text)
    return []
  },
}

async function runEffect(r: Runtime, effect: Effect, batch: Batch): Promise<MachineEvent[]> {
  const runner = EFFECT_RUNNERS[effect.type] as EffectRunner<Effect['type']>
  return runner(r, effect as never, batch)
}

// ---- load ----------------------------------------------------------------------

/** The Claude process id: the parent of a `sh` child (the d.ts offers no pid; see owner.ts). */
async function claudePid(host: Host, stateDir: string, sessionId: string): Promise<number | null> {
  try {
    return parsePid((await host.run(['sh', '-c', 'echo $PPID'], 5_000)).stdout)
  } catch (error) {
    // No pid: a fresh owner is minted and never adopted (reload recovery then resets). Logged before rt exists.
    await writeLog(host, stateDir, sessionId, 'pid-probe-failed', errorText(error))
    return null
  }
}

async function utcOffset(host: Host): Promise<number> {
  try {
    const run = await host.run(['date', '+%z'], 5_000)
    return parseUtcOffset(run.stdout) ?? -new Date().getTimezoneOffset()
  } catch {
    return -new Date().getTimezoneOffset() // `date` unavailable: the environment's own offset (may be UTC).
  }
}

async function start($: Engine, options: Readonly<Record<string, unknown>>, isInteractive: boolean): Promise<void> {
  const env = await readEnv($)
  const { config, warnings } = resolveConfig(options, env)
  const home = env.home ?? ''
  const stateDir = env.stateDir || `${home}/.claude/state/context-handoff`
  const briefDir = env.briefDir || `${home}/.claude/state/compact-handoffs`
  const sessionId = await $.session.id()
  const inert = !isInteractive ? 'not interactive' : config.isDisabledByEnv ? 'CONTEXT_HANDOFF_DISABLE=1' : (await $.fs.exists(`${stateDir}/DISABLED`)) ? 'DISABLED file' : null
  if (inert !== null) {
    rt = null
    await writeLog(hostOf($), stateDir, sessionId, 'inert', inert)
    return
  }
  const host = hostOf($)
  const pid = await claudePid(host, stateDir, sessionId)
  const owner = resolveOwner(env.owner, pid, crypto.randomUUID())
  if (!owner.isAdopted) await $.env.set('CONTEXT_HANDOFF_OWNER', owner.ownerId)
  const ownerId = owner.ownerId
  const at = await $.clock.now()
  // `<load time>-<uuid>`: the store refuses only writes from a load older than the file's writer.
  const loadId = `${at}-${crypto.randomUUID()}`
  const r: Runtime = {
    host, config, ownerId, loadId, stateDir, briefDir, home,
    repoRoot: $.plugin.root,
    utcOffsetMinutes: await utcOffset(host),
    machine: initialState(sessionId, at, ownerId),
    persistedSessionId: sessionId,
    toolName: null, band: null, turns: new TurnTracker(),
    runTurns: new Set(), reloadWindow: null, runToolCalls: 0, runDeclared: null, preparation: null, manualPreparations: 0, ownTrackCalls: [], pendingSeed: null, initialSeed: null, isInSessionStart: false,
    hasPinnedNotice: false, lastTokens: null, isTypedDuringTurn: false, pendingNudge: null, facts: null, factsGeneration: 0,
    reviewStoreDir: resolveReviewStoreDir(home, env.reviewStore), reviews: new ReviewWatch(), seedTurn: null,
    activityRevision: 0, activityGeneration: `${loadId}:0`, activityWrites: Promise.resolve(), pollingCycle: null,
    trackCheckpoint: null, checkpointAttempts: null, restoredCycle: null, restoredReceipt: null, decisionLimitCycle: null, rearmedWindow: null, replayInFlight: null,
  }
  rt = r
  await pruneSessions(r, sessionId, at)
  const loaded = await loadMachine(storeFsOf(host, stateDir, sessionId), stateDir, sessionId, ownerId, loadId, at)
  r.machine = loaded.state
  r.persistedSessionId = loaded.persistedSessionId
  r.reloadWindow = loaded.reloadWindow
  await invalidateActivity(r)
  const relay = await relayObservation(r)
  if (relay.transcriptPath !== null && acceptsTranscript(r.machine, sessionId)) {
    await dispatch({ type: 'transcriptSeen', sessionId, transcriptPath: relay.transcriptPath })
  }
  if (r.reloadWindow !== null) {
    for (const turnId of r.reloadWindow) r.runTurns.add(turnId)
    await log('reload-window', `run turns [${r.reloadWindow.join(',')}]: the allowlist holds until the next turn end`)
  }
  await log('loaded', `owner=${ownerId} adopted=${owner.isAdopted} load=${loadId} phase=${r.machine.phase} config=${JSON.stringify(config)}${warnings.length ? ` warnings=${warnings.join('; ')}` : ''}`)
  if ((await persistMachine(r)) === 'superseded') {
    await log('superseded', `load ${loadId} found a newer load's file; this load stays inert`)
    rt = null
    return
  }
  const loadBatch = newBatch()
  for (const effect of loaded.effects) for (const follow of await runEffect(r, effect, loadBatch)) await dispatch(follow)
  if (r.machine.responseReplay?.status === 'pending') r.host.after(0, () => void replayResponse(r))
  try {
    const registered = await $.tool.register({ name: HANDOFF_NOW_NAME, description: HANDOFF_NOW_DESCRIPTION, inputSchema: HANDOFF_NOW_INPUT_SCHEMA })
    r.toolName = registered.tool
  } catch (error) {
    await log('tool-register-failed', errorText(error))
  }
  await logCommandList(r)
  $.clock.every(WATCHDOG_MS, () => {
    if (!rt || rt.machine.phase === 'IDLE') return
    void (async () => {
      const live = rt as Runtime
      // Detached: a rejection here is logged. A failed kill-switch check reads as on only before the
      // clear (BRIEFING, GRACE), so no /clear starts from this tick; after the clear it reads as off, so
      // deadlines and the seed fallback still run.
      const isKill = await isKillSwitchOn(live).catch(async (error: unknown) => {
        const beforeClear = isBeforeClear(live.machine.phase)
        await log('watchdog-failed', `kill switch check: ${clip(errorText(error), 200)}; this tick reads it as ${beforeClear ? 'on (before the clear)' : 'off (after the clear)'}`)
        return beforeClear
      })
      await dispatch({ type: 'tick', now: await now(), isKillSwitchOn: isKill })
      // After the tick's dispatch, so a read never delays or skips it. Only a confirmed open review cancels.
      const cycleId = live.machine.cycleId
      if (rt === live && cycleId !== null && (live.machine.phase === 'BRIEFING' || live.machine.phase === 'GRACE')) {
        const open = confirmedOpen(await readReviews(live, live.machine.sessionId, 'in-cycle'))
        if (open > 0) await dispatch({ type: 'reviewOpen', cycleId, now: await now(), count: open, at: 'watchdog' })
      }
      if (live.band?.kind === 'grace') live.host.invalidate()
    })().catch((error: unknown) => log('watchdog-failed', clip(errorText(error), 300)))
  })
}

// ---- turn handling ------------------------------------------------------------


/** A Track read that can stall must not hold the turn-end decision: past this the receipt is unknown. */
const DECISION_CHECK_TIMEOUT_MS = 3_000

/** TRACK-25: Track's waiting rows for a 👉 decision turn end; any failure is 'unknown', which holds. */
async function decisionRows(r: Runtime, source: string): Promise<WaitingRows> {
  try {
    const timeout = r.host.sleep(DECISION_CHECK_TIMEOUT_MS).then(() => ({ failure: 'timed out' }))
    const result = await Promise.race([requestTrackCheckpoint(r, source), timeout])
    if ('failure' in result) {
      await log('decision-check', `failed: ${clip(result.failure, 200)}`)
      return 'unknown'
    }
    const rows = waitingRowsOf(result.checkpoint)
    await log('decision-check', rows === 'unknown' ? 'failed: no open_steps inventory' : rows === 'absent' ? 'track=absent' : `waiting=${rows}`)
    return rows
  } catch (error) {
    await log('decision-check', `failed: ${clip(errorText(error), 200)}`)
    return 'unknown'
  }
}

/** The main turn whose end a Track read may delay: what checkTrackBeforeDispatch re-reads and cancels. */
type DecisionTurn = { sessionId: string; turnId: string; isTypedPending: boolean; cancelStaleDecision: () => Promise<boolean> }

/**
 * TRACK-25: a turn end that would start the run over a 👉 decision first reads Track's waiting rows.
 * The read can outlive the turn: on a generation change the stale decision is cancelled and nothing
 * is dispatched; otherwise the draft, pending, kill-switch and review guards are read again, and the
 * event names the window whose one re-arm was already delivered.
 */
async function checkTrackBeforeDispatch(r: Runtime, generation: string, turn: DecisionTurn, ev: MachineEvent): Promise<MachineEvent | null> {
  if (ev.type !== 'turnEnd' || !needsDecisionCheck(r.machine, ev, r.config)) return ev
  const waitingRows = await decisionRows(r, turn.sessionId)
  if (rt !== r || generation !== r.activityGeneration) {
    await log('decision-check', `stale: activity changed during the Track read; turn ${turn.turnId} not dispatched`)
    await turn.cancelStaleDecision()
    return null
  }
  return {
    ...ev, waitingRows, rearmedWindow: r.rearmedWindow, now: await r.host.now(), draft: (await r.host.readPrompt()).text,
    isKillSwitchOn: await isKillSwitchOn(r), isTypedPending: turn.isTypedPending || r.isTypedDuringTurn,
    openReviews: openReviewsOf(await readReviews(r, turn.sessionId)),
  }
}

async function onTurnComplete($: Engine, e: { answer: string; reason: string; turnId: string; agentId?: string }): Promise<void> {
  const r = rt
  if (!r) return
  if (e.agentId !== undefined) {
    await invalidateActivity(r)
    return
  }
  await log('turn-end', `turn ${e.turnId} reason=${e.reason}`)
  const isHandoffTurn = r.reloadWindow !== null || 'queue' in gateHandoffNow(r.turns.current, undefined, isAutoRunTurn(r.machine, e.turnId))
  const responseSession = r.machine.sessionId
  if (e.reason === 'answer' && e.answer.trim() !== '' && await $.session.id() === responseSession) {
    await dispatch({ type: 'responseCompleted', sessionId: responseSession, turnId: e.turnId,
      answer: e.answer, reason: e.reason, isHandoffTurn })
  }
  r.turns.onTurnComplete(e.turnId)
  r.runTurns.delete(e.turnId)
  r.reloadWindow = null
  const usage = await $.session.usage()
  r.lastTokens = usage.context.tokens ?? r.lastTokens
  const draft = (await $.prompt.read()).text
  const sessionId = await $.session.id()
  const kill = await isKillSwitchOn(r)
  const isTypedPending = r.isTypedDuringTurn
  r.isTypedDuringTurn = false
  if (r.seedTurn !== null && r.seedTurn.turnId === e.turnId) {
    if (!r.seedTurn.isCalled) await log('track-restore', 'not-called')
    r.seedTurn = null
  }
  const openReviews = openReviewsOf(await readReviews(r, sessionId))
  const event: MachineEvent = {
    type: 'turnEnd', now: await $.clock.now(), sessionId, turnId: e.turnId,
    reason: e.reason as TurnEndReason, percent: usage.context.percent, tokens: usage.context.tokens,
    draft, isKillSwitchOn: kill, answer: e.answer, isTypedPending, openReviews, isHandoffTurn,
  }
  // Deferred so the Stop command hook can publish after this native event.
  // Unknown blocks immediately; a matching late observation can resume this
  // same decision for the command hook's full 5-second budget.
  const generation = r.activityGeneration
  const decisionCycle = r.machine.cycleId
  const decisionPending = r.machine.manualPending
  const isRunDecision = r.machine.phase === 'BRIEFING' && r.machine.autoRun?.turnIds.includes(e.turnId) === true
  const cancelStaleDecision = async (): Promise<boolean> => {
    if (rt !== r) return true
    if (generation === r.activityGeneration) return false
    // This main turn will not end a second time. A generation change must
    // resolve its safety decision, including a run that has not queued a brief.
    // An old callback cannot cancel a newer cycle or a different manual brief.
    const isSameDecision = r.machine.cycleId === decisionCycle &&
      (isRunDecision || (decisionPending !== null && r.machine.manualPending?.path === decisionPending.path && r.machine.manualPending?.turnId === decisionPending.turnId))
    if (isSameDecision && (isBeforeClear(r.machine.phase) || r.machine.manualPending !== null)) {
      const brief = r.machine.manualPending?.path ?? r.machine.briefPath
      await dispatch({ type: 'cancel', now: await r.host.now(), reason: 'activity-unknown' })
      await pinStatus(r, `context-handoff: activity changed while waiting for Stop; context retained, clear was not issued; ${brief === null ? 'no verified brief was queued' : `the brief is ${brief}`}`)
    }
    return true
  }
  const turn: DecisionTurn = { sessionId, turnId: e.turnId, isTypedPending, cancelStaleDecision }
  r.host.after(0, () => {
    void (async () => {
      const isKnown = await refreshActivity(r, generation)
      if (await cancelStaleDecision()) return
      // A queued brief would be cancelled by an unknown turn-end observation.
      // Wait before making that decision, rather than trying to revive an aborted cycle.
      if (!isKnown && (r.machine.phase === 'BRIEFING' || r.machine.manualPending !== null)) {
        await refreshActivity(r, generation, 5_000)
        if (await cancelStaleDecision()) return
        const current: MachineEvent = { ...event, now: await r.host.now(), draft: (await r.host.readPrompt()).text,
          isKillSwitchOn: await isKillSwitchOn(r), isTypedPending: isTypedPending || r.isTypedDuringTurn,
          openReviews: openReviewsOf(await readReviews(r, sessionId)) }
        await dispatch(current)
        return
      }
      const known = await checkTrackBeforeDispatch(r, generation, turn, event)
      if (known === null) return
      // The guard re-reads after a Track read can outlive the generation too; recheck it, as the later path does.
      if (await cancelStaleDecision()) {
        if (known !== event) await log('decision-check', `stale: activity changed during the guard re-reads; turn ${e.turnId} not dispatched`)
        return
      }
      await dispatch(known)
      if (isKnown || !(await refreshActivity(r, generation, 5_000))) return
      const current: MachineEvent = {
        ...event, now: await r.host.now(), draft: (await r.host.readPrompt()).text,
        isKillSwitchOn: await isKillSwitchOn(r),
        isTypedPending: isTypedPending || r.isTypedDuringTurn,
        openReviews: openReviewsOf(await readReviews(r, sessionId)),
      }
      const later = await checkTrackBeforeDispatch(r, generation, turn, current)
      if (later !== null && rt === r && generation === r.activityGeneration) await dispatch(later)
    })().catch(error => log('activity-read-failed', errorText(error)))
  })
}

/**
 * Stage 1: while the nudge window is open (IDLE, no nudge yet), a main tool result measures the
 * context; the machine answers the one nudge text at the threshold, or nothing.
 */
async function measureForNudge($: Engine, r: Runtime): Promise<string | null> {
  // TRACK-25: a nudge re-armed by a held decision turn (or TRACK-33's background reminder) rides this tool result, only while that hold can still be open.
  const queued = r.pendingNudge
  r.pendingNudge = null
  if (queued !== null && r.machine.phase === 'IDLE' && r.machine.nudge !== null) return queued
  if (r.machine.phase !== 'IDLE' || r.machine.nudge !== null || r.machine.manualPending !== null) return null
  const usage = await $.session.usage()
  if (!reachesThreshold(r.machine, usage.context, r.config)) return null // below: no event, no state write per tool call
  const sessionId = await $.session.id()
  await dispatch({
    type: 'contextMeasured', now: await $.clock.now(), sessionId,
    // The caller returned early when the kill switch is on. The nudge is never held by a review.
    tokens: usage.context.tokens, percent: usage.context.percent, isKillSwitchOn: false,
    openReviews: openReviewsOf(await readReviews(r, sessionId)),
  })
  const nudge = r.pendingNudge
  r.pendingNudge = null
  return nudge
}

// ---- the band ------------------------------------------------------------------

function renderBand($: Engine, e: unknown, r: Runtime, at: number) {
  const { Box, Button, Text } = $.ui.resolve(e as never) as Record<string, (props: Record<string, unknown>) => unknown>
  const band = r.band
  if (band?.kind === 'grace') {
    const seconds = Math.max(0, Math.ceil((band.deadline - at) / 1000))
    return (
      <Box>
        <Text>Context handoff: brief written, clearing in {seconds}s </Text>
        <Button key="handoff-cancel" label="Cancel" variant="primary" onPress={() => void cancelHandoff(r)} />
      </Box>
    )
  }
  return (
    <Box>
      <Text>Handoff queued for this turn end </Text>
      <Button key="handoff-queued-cancel" label="Cancel" onPress={() => void cancelHandoff(r)} />
    </Box>
  )
}

async function cancelHandoff(r: Runtime): Promise<void> {
  await dispatch({ type: 'cancel', now: await r.host.now(), reason: 'button' })
}

// ---- registration --------------------------------------------------------------

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    try {
      await start($, options, e.isInteractive)
    } catch (error) {
      rt = null
      $.ui.log(`context-handoff: not started: ${errorText(error)}`)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await onTurnComplete($, e)
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    if (rt) await invalidateActivity(rt)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    // The record goes in before the settings Stop hooks, so the guards read this turn's counts;
    // a `block` from those hooks re-prompts the model, so it cancels a running cycle after them.
    const record = rt ? stopRecord(e) : null
    if (record) await dispatch(record)
    const result = await next(e)
    if (!rt) return result
    const cancel = stopBlockCancel(e, result, await $.clock.now())
    if (cancel) {
      await log('stop-blocked', (result.block ?? '').slice(0, 200))
      await dispatch(cancel)
    }
    return result
  }).catch(($, e, next) => {
    // Fails safe, as if the hook were absent: the turn ends unblocked; a cycle keeps the counts of the Stop before.
    // A failure after the settings hooks answered passes their block on but skips the cycle cancel (residual).
    logHookFailure('classic.Stop', next.error)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const r = rt
    if (!r) return next(e)
    await invalidateActivity(r)
    const raw = e.origin as { kind: string; name?: string }
    // The run's own prompt names its cycle: own-skill only for the cycle armed now (live: it fires before turn.start).
    const armedCycle = r.machine.phase === 'BRIEFING' && r.machine.autoRun !== null ? r.machine.cycleId : null
    const origin = originOf(raw, $.plugin.name, e.text, armedCycle)
    if (origin === 'own-skill') await dispatch({ type: 'autoRunSubmit', cycleId: autoRunCycleOf(e.text) as string, now: await $.clock.now() })
    await log('prompt-submit-seen', `origin=${raw.kind}${raw.name ? `:${raw.name}` : ''} turnId=${e.turnId ?? '-'} text=${JSON.stringify(e.text.slice(0, 60))}`)
    const seed = r.pendingSeed
    if (origin === 'own-seed' && seed && e.text === seed.text) {
      const answer = await next({ ...e, context: [...(e.context ?? []), seed.note] })
      await log('seed-seen', `${seed.cycleId} hooks saw text=${JSON.stringify(e.text)}`)
      r.pendingSeed = null
      await dispatch({ type: 'seedDelivered', cycleId: seed.cycleId, now: await $.clock.now() })
      return answer
    }
    r.turns.onPromptSubmit(origin, e.text, e.turnId)
    if (isTypedPrompt(e.origin as { kind: string }) && isAmqDoorbell(e.text)) {
      // CC-177: the AMQ wake injector types its doorbell into the composer. It is a wake-up only (the message stays
      // in the AMQ inbox for the next session), so it neither cancels a cycle nor makes the turn end unclean.
      await log('doorbell-seen', `turnId=${e.turnId ?? '-'} not counted as a typed prompt`)
      return next(e)
    }
    if (isTypedPrompt(e.origin as { kind: string })) {
      // Typed over a running turn (d.ts PromptSubmitInput.turnId): it waits to start the next turn, so that turn end is not clean.
      if (e.turnId !== undefined) r.isTypedDuringTurn = true
      invalidateFacts(r, `typed prompt (${(e.origin as { kind: string }).kind})`)
      r.reloadWindow = null
      if (r.hasPinnedNotice) {
        $.ui.status(undefined)
        r.hasPinnedNotice = false
      }
      await dispatch({ type: 'typedPrompt', now: await $.clock.now() })
    }
    return next(e)
  }).catch(($, e, next) => {
    // Fails safe, as if the hook were absent: the prompt goes in as typed: no seed note, no cancel.
    logHookFailure('prompt.submit', next.error)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    const r = rt
    if (!r) return result
    await invalidateActivity(r)
    const { origin, isPrompted } = r.turns.onTurnStart(e.turnId, e.text)
    r.isTypedDuringTurn = false
    // The restore signal binds the first turn that carries the seed (submitted or the initial message).
    if (r.seedTurn !== null && r.seedTurn.turnId === null && e.text.includes(r.seedTurn.text)) r.seedTurn.turnId = e.turnId
    // TurnStartInput carries no origin (d.ts); `origin` is the mod's own binding from prompt.submit.
    await log('turn-start', `turn ${e.turnId} origin=${origin} text=${JSON.stringify(e.text.slice(0, 60))} (${e.text.length} chars)`)
    const seed = r.pendingSeed
    if (seed?.via === 'initial' && e.text.includes(seed.text)) {
      r.pendingSeed = null
      await dispatch({ type: 'seedDelivered', cycleId: seed.cycleId, now: await $.clock.now() })
      return result
    }
    const runBefore = r.machine.phase === 'BRIEFING' ? r.machine.autoRun : null
    await dispatch({ type: 'turnStart', now: await $.clock.now(), origin, turnId: e.turnId, text: e.text, isPrompted })
    if (runBefore?.isWaiting) {
      // [live] what a continuation turn after the run turn really carries (binding expects it empty and unprompted).
      await log('auto-run-continuation-turn', `turn ${e.turnId} prompted=${isPrompted} stopBlocked=${runBefore.isStopBlocked} origin=${origin} text=${JSON.stringify(e.text.slice(0, 200))} (${e.text.length} chars)`)
    }
    // The machine bound this turn to the automatic run: the allowlist holds until the turn ends.
    if (rt && isAutoRunTurn(rt.machine, e.turnId)) rt.runTurns.add(e.turnId)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (rt) {
      await log('session-end', `reason=${e.reason} id=${e.sessionId}`)
      await dispatch({ type: 'sessionEnd', now: await $.clock.now(), reason: e.reason })
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = rt
    if (!r || e.agent_id !== undefined) return next(e)
    await log('session-start', `source=${e.source} session_id=${e.session_id} process id=${await $.session.id()}`)
    r.isInSessionStart = true
    if (e.session_id !== r.machine.sessionId) invalidateFacts(r, `session change (${e.source})`)
    try {
      // Runs before the settings SessionStart hooks (module hooks come first), so carried markers are visible to them.
      await dispatch({ type: 'sessionStart', now: await $.clock.now(), sessionId: e.session_id, source: e.source })
    } finally {
      r.isInSessionStart = false
    }
    // After the sessionStart event, so the record is checked against the session it switched to; and only
    // when the input's id is the process's, so a clear carrying the old id never files the new path under it.
    const seen = e.session_id === (await $.session.id()) ? transcriptRecord(e) : null
    if (seen && acceptsTranscript(r.machine, seen.sessionId)) await dispatch(seen)
    const result = await next(e)
    if (r.initialSeed === null) return result
    const initialUserMessage = r.initialSeed
    r.initialSeed = null
    await log('seed-initial', 'handed to SessionStart initialUserMessage')
    return { ...result, initialUserMessage }
  }).catch(($, e, next) => {
    // Fails safe, as if the hook were absent: the session starts without a seed or a transcript record.
    // A throw before the `try` leaves isInSessionStart set (pre-existing; seed routing reads it).
    logHookFailure('classic.SessionStart', next.error)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = rt
    if (!r) return next(e)
    if (shouldVetoCompaction(r.machine, e.trigger, e.agentId)) {
      await log('veto', `${r.machine.cycleId} ${e.trigger} compaction skipped in ${r.machine.phase}`)
      return { skip: 'context-handoff: a verified brief is written and this session is about to be handed off' }
    }
    if (e.trigger === 'auto' && e.agentId === undefined && r.machine.phase === 'IDLE') {
      // The safety net: in IDLE with the guards passing, skip this compaction once and run the skill instead.
      const usage = await $.session.usage()
      const before = r.machine.cycleId
      const sessionId = await $.session.id()
      // A compact decision must not reuse idle counts from an older native event.
      await refreshActivity(r, r.activityGeneration)
      await dispatch({
        type: 'compactRequested', now: await $.clock.now(), sessionId,
        percent: usage.context.percent, tokens: usage.context.tokens, draft: (await $.prompt.read()).text, isKillSwitchOn: await isKillSwitchOn(r),
        openReviews: openReviewsOf(await readReviews(r, sessionId)),
      })
      const after: MachineState = r.machine // dispatch replaced it; TS still narrows to IDLE
      if (after.phase === 'BRIEFING' && after.cycleId !== before) {
        return { skip: 'context-handoff: running /compact-crafter to hand this session off instead' }
      }
    }
    const result = await next(e)
    if (e.agentId === undefined) await log('compaction', `trigger=${e.trigger} skipped=${'skip' in result && result.skip !== undefined}`)
    const isDone = !('skip' in result && result.skip !== undefined)
    if (isDone && e.agentId === undefined && e.trigger !== 'precompute') {
      await dispatch({ type: 'compacted', now: await $.clock.now(), trigger: e.trigger })
    }
    return result
  }).catch(($, e, next) => {
    // Fails safe, as if the hook were absent: the compaction runs; a failure never skips one.
    logHookFailure('session.compact', next.error)
    return next(e)
  })

  on('classic.PreCompact', async ($, e, next) => {
    if (rt && e.agent_id === undefined) {
      await log('pre-compact-classic', `trigger=${e.trigger}`)
    }
    return next(e)
  }).catch(($, e, next) => {
    // Fails safe, as if the hook were absent: the compaction goes on.
    logHookFailure('classic.PreCompact', next.error)
    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    const r = rt
    if (!r || e.agent_id !== undefined || (await isKillSwitchOn(r))) return result
    const rewritten = rewriteCompactWarning(result.additionalContext, r.config.thresholdTokens === null ? (r.config.thresholdPercent as number) : `${r.config.thresholdTokens} tokens`)
    if (rewritten.isChanged) await log('warning-rewritten', `tool=${e.tool_name}`)
    // A fresh session has no Stop record yet: take the path from this input before the nudge's precompute reads it.
    const seen = transcriptRecord(e)
    if (seen && acceptsTranscript(r.machine, seen.sessionId)) await dispatch(seen)
    if (!rewritten.isChanged) return result
    return { ...result, additionalContext: rewritten.entries }
  }).catch(($, e, next) => {
    // Fails safe, as if the hook were absent: the tool result goes on without a nudge or a rewrite.
    logHookFailure('classic.PostToolUse', next.error)
    return next(e)
  })

  // handoff_now's schema always sits in the prompt's tool list: behind ToolSearch the armed window
  // (which never admits ToolSearch) left the run unable to reach the door (live check P1). Unconditional,
  // so the answer is stable and the prompt cache holds.
  on('tool.describe', { tool: `mcp__context-handoff__${HANDOFF_NOW_NAME}` }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', async ($, e, next) => {
    // E-H1: the mod's own Track call from another hook (the Stop-cancel path) reaches this guard; exactly the
    // recorded call is admitted, outside the tool cap. A model call (origin engine) never takes this branch.
    const origin = (next as unknown as { origin?: { plugin?: string } }).origin
    if (rt && origin?.plugin === $.plugin.name && takeOwnTrackCall(rt, e as unknown as Record<string, unknown>)) {
      await log('own-track-admitted', e.tool)
      return next(e)
    }
    if (rt) await invalidateActivity(rt)
    const answer = await (async () => {
      const r = rt
      if (!r) return next(e)
      const args = e as unknown as Record<string, unknown> & { snapshot_path?: unknown; agentId?: string }
      const turn = r.turns.current
      const seedTurn = r.seedTurn
      if (seedTurn !== null && !seedTurn.isCalled && args.agentId === undefined && seedTurn.turnId !== null && seedTurn.turnId === turn?.turnId && RESTORE_TOOLS.has(e.tool)) {
        seedTurn.isCalled = true
        await log('track-restore', `called ${e.tool}`)
      }
      // TRACK-25 U4: handoff_now in a turn of a run that already ended answers the real ending reason, and
      // before the armed window, so the tool cap cannot answer in its place. A turn the live run owns never
      // takes an older run's ending (a reused turn id).
      const isEndedCandidate = r.toolName !== null && e.tool === r.toolName && args.agentId === undefined && turn !== null && !isAutoRunTurn(r.machine, turn.turnId)
      const ended = isEndedCandidate ? runEndedFor(r.machine.lastRunEnd, turn?.turnId ?? null, r.config.autoRunTimeoutSeconds) : undefined
      if (ended !== undefined) {
        const gate = gateHandoffNow(turn, args.agentId, false, ended)
        if ('refuse' in gate) {
          await log('handoff-now-refused', `run-ended ${ended.event}`)
          return { result: gate.refuse }
        }
      }
      // The armed window: every call in a run turn (or by a subagent while one is current) is checked.
      if (isInRunWindow(turn?.turnId ?? null, r.runTurns, r.reloadWindow)) {
        const key = callKey(e)
        if (key !== null) guardedCalls.add(key)
        r.runToolCalls += 1
        // The verdict is whole before any log or dispatch is awaited. The deny-path log (and the cap's
        // dispatch) are then awaited before the deny returns, so a slow log can delay it (up to the log's
        // 5 s process timeout) but never skip it: a failed or overrun hook lands in the `.catch`, which
        // denies while the window is open.
        const isOverCap = r.runToolCalls > r.config.autoRunToolCap
        const call = { tool: e.tool, input: args }
        const ctx: RunContext = {
          handoffTool: r.toolName ?? `mcp__context-handoff__${HANDOFF_NOW_NAME}`, repoRoot: r.repoRoot,
          home: r.home, briefDir: r.briefDir, sessionId: await $.session.id(), transcriptPath: r.machine.transcriptPath,
        }
        const landings = isOverCap ? new Map<string, Landing>() : await landingsOf($, resolveTargets(call, ctx))
        const verdict = isOverCap ? null : allowInRun(call, ctx, path => landings.get(path) ?? 'nowhere')
        if (verdict === null) {
          await log('auto-run-denied', `${e.tool}: tool cap ${r.config.autoRunToolCap} reached`)
          if (r.machine.phase === 'BRIEFING' && r.machine.cycleId !== null) {
            await dispatch({ type: 'autoRunFailed', cycleId: r.machine.cycleId, now: await $.clock.now(), failure: `tool cap ${r.config.autoRunToolCap} reached` })
          }
          return { deny: `context-handoff automatic run: the tool cap (${r.config.autoRunToolCap}) is reached; stop and print one line.` }
        }
        if ('deny' in verdict) {
          await log('auto-run-denied', `${e.tool} ${clip(JSON.stringify(args.command ?? args.file_path ?? ''), 160)}`)
          return verdict
        }
        const cycleId = r.machine.cycleId
        if (e.tool === 'Write' && turn !== null && r.machine.phase === 'BRIEFING' && cycleId !== null && isAutoRunTurn(r.machine, turn.turnId)) {
          const refused = await registerAtWrite(r, a => $.tool.call(a), cycleId, turn.turnId)
          if (refused !== null) {
            await log('auto-run-denied', `Write: the Track preparation step could not be registered`)
            return { deny: `context-handoff automatic run: the Track preparation step could not be registered (${clip(refused.replace(/\s+/g, ' '), 200)}); stop and print one line.` }
          }
        }
      }
      if (r.toolName === null || e.tool !== r.toolName) return next(e)
      const isArmed = turn !== null && isAutoRunTurn(r.machine, turn.turnId)
      const gate = gateHandoffNow(turn, args.agentId, isArmed)
      if ('refuse' in gate || turn === null) {
        await log('handoff-now-refused', `origin=${turn?.origin ?? 'none'}`)
        return { result: 'refuse' in gate ? gate.refuse : HANDOFF_NOW_REFUSAL }
      }
      // Before any brief is written: a handoff now would strand an open review. A typed handoff also
      // waits on an unreadable state; in the automatic run the cycle has started, so only a confirmed
      // open review refuses (amendment A2: one torn read must not fail the run and charge it).
      const read = await readReviews(r, await $.session.id())
      const held = plannotatorRefusal(isArmed ? confirmedOpen(read) : openReviewsOf(read))
      if (held !== null) {
        await log('handoff-now-refused', held)
        return { result: `handoff not queued: ${held}` }
      }
      return { result: await queueHandoff(r, args.snapshot_path, turn, gate.queue, a => $.tool.call(a)) }
    })()
    const key = callKey(e)
    if (key !== null) guardedCalls.delete(key)
    const r = rt
    if (!r || e.tool === r.toolName || e.agentId !== undefined || answer.deny !== undefined || answer.isError === true || (await isKillSwitchOn(r))) return answer
    const nudge = await measureForNudge($, r)
    return nudge === null ? answer : { ...answer, context: [...(answer.context ?? []), nudge] }
  }).catch(($, e, next) => {
    // d.ts tool.call: "A guard that fails is skipped and the tool runs". In the window it refuses
    // where `next` was not called; outside it the call goes on as if the hook were absent (an
    // unanswered handoff_now then fails in the engine: "a call no hook answers fails").
    const key = callKey(e)
    const wasArmed = key !== null && guardedCalls.delete(key)
    const r = rt
    const isArmed = wasArmed || (r !== null && isInRunWindow(r.turns.current?.turnId ?? null, r.runTurns, r.reloadWindow))
    logHookFailure('tool.call', next.error)
    if (isArmed && !next.called) return { deny: 'context-handoff automatic run: the guard failed, so this call is refused. Only the compact-crafter steps are allowed in this turn.' }
    return next(e)
  })

  on('ui.render', { component: 'Placed' }, ($, e, next) => {
    const r = rt
    const replay = r?.machine.responseReplay
    if (!r || !replay || replay.attemptId === undefined || replay.destinationSession !== r.machine.sessionId ||
      (replay.status !== 'attempted' && replay.status !== 'shown') || e.props.plugin !== 'context-handoff' ||
      e.props.id !== responseRowId(replay.attemptId)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column"><Text>Previous session response:</Text><Text>{replay.response.text}</Text></Box>
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = rt
    if (!r || r.band === null) return next(e)
    return renderBand($, e, r, await $.clock.now())
  })
}
