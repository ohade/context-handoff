import { fixturePath } from './paths'

// The world beneath the context-handoff mod in an engine test (`claude plugin test`):
// an in-memory file tree and env, and a record of every engine call the mod made.
// In-memory fixture examples from Anthropic code-modernization, modified for this plugin.
// See THIRD_PARTY_NOTICES.md and licenses/Apache-2.0.txt for upstream attribution.
import type { On } from 'claude-code'

export const OLD = '11111111-aaaa-4bbb-8ccc-000000000001'
export const NEW = '22222222-aaaa-4bbb-8ccc-000000000002'
export const STATE = fixturePath('state')
/** The pid the world reports for the Claude process (owner stamps are `<pid>:<uuid>`). */
export const PID = 4242
export const BRIEFS = fixturePath('briefs')
export const TRANSCRIPT = fixturePath('home/.claude/projects/p/11111111-aaaa-4bbb-8ccc-000000000001.jsonl')

export const TEMPLATE = [
  '<!-- header -->', 'session: <id>', 'previous: <id>', 'transcript: <path>', 'created: <time>', '<!-- /header -->', '',
  '## 1. Active goal and role', '*g*', '## 2. User decisions and constraints, verbatim, dated', '*g*',
  '## 3. Pending, owned by the user', '*g*', '## 4. In flight', '*g*', '## 5. Identifiers the next context must type', '*g*',
  '## 6. Last outgoing instruction', '*g*', '## 7. Do not redo', '*g*', '## 8. Last request and status', '*g*',
  '## 9. Dead ends', '*g*', '## 10. Assumptions to verify', '*g*', '',
].join('\n')

/** The model-written sections 1-10 of a skill snapshot. */
export const SECTIONS_TEXT = [
  '## 1. Active goal and role', 'Ship it.', '## 2. User decisions and constraints, verbatim, dated', '- none',
  '## 3. Pending, owned by the user', '- none', '## 4. In flight', '- none', '## 5. Identifiers the next context must type', '- none',
  '## 6. Last outgoing instruction', '- none', '## 7. Do not redo', '- none', '## 8. Last request and status', 'Finish.', 'Status: partial',
  '## 9. Dead ends', '- none', '## 10. Assumptions to verify', '- none',
].join('\n')

/** A non-empty conversation: a compaction leaves at least one message. */
export const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

/** A skill snapshot (C2): header, then sections 1-10 (no Facts; the mod adds its own). */
export const SNAPSHOT_TEXT = () =>
  `# Snapshot\n<!-- header -->\nsession: ${OLD}\nprevious: none\ntranscript: ${TRANSCRIPT}\ncreated: 2026-10-05T10:00:00+03:00\n<!-- /header -->\n\n${SECTIONS_TEXT}\n`

/** The automatic run's prompt as its own prompt.submit hook sees it. */
export const RUN_PROMPT = (cycleId: string, sessionId = OLD) => `/context-handoff:compact-crafter automatic-run cycle=${cycleId} session=${sessionId}`
/** The run turn's text is expanded command markup, never the raw slash line. */
export const RUN_TURN_TEXT = (cycleId: string, sessionId = OLD) =>
  `<command-message>context-handoff:compact-crafter</command-message>\n<command-name>/context-handoff:compact-crafter</command-name>\n<command-args>automatic-run cycle=${cycleId} session=${sessionId}</command-args>`
/** Where the skill writes its snapshot in an automatic run: directly under the brief dir, named with the full session id. */
export const RUN_SNAPSHOT = fixturePath(`briefs/${OLD}-snapshot.md`)

export const FACTS = '## Facts from the transcript\nSource: x (generated y)\n### Files edited\n- none\n### Commits\n- none\n### Tickets\n- none\n### Last user request\n- none\n'

export type World = {
  files: Map<string, string>
  env: Record<string, string | undefined>
  sessionId: string
  percent: number | undefined
  tokens: number | undefined
  draft: string
  /** `stderr` (TRACK-23 v3): what the run printed there; '' when absent. */
  extractor: { exitCode: number; stdout: string; stderr?: string }
  /** argv of every extractor run (python3 ... transcript-facts.py ...). */
  extractorRuns: string[][]
  clearRejects: boolean
  /** When set, command.run(clear) switches the session id to this value. */
  clearSwitchesTo: string | null
  compactAnswer: () => Promise<Record<string, unknown>>
  /** When set, the settings Stop hook beneath blocks with this text (a re-prompt). */
  stopBlock: string | null
  /** When true, plugin-submitted prompts are dropped beneath (a lost seed). */
  dropPluginPrompts: boolean
  /** FIXTURE stand-in for the independently invoked SessionStart/Stop command relay. */
  relayOnStart: boolean
  relayOnStop: boolean
  backgroundTasks: unknown[] | null
  sessionCrons: unknown[] | null
  commands: string[]
  /** Every command.run that reached the bottom of the chain, with the origin the engine stamped. */
  commandRuns: Array<{ command: string; origin: unknown }>
  submits: string[]
  notes: unknown[]
  /** Plugin prompts that are the automatic run's own `/context-handoff:compact-crafter automatic-run …` (not seeds). */
  runPrompts: string[]
  fills: string[]
  statuses: (string | undefined)[]
  logs: string[]
  tools: string[]
  /** Supported native tool catalogue; Track is independently absent by default. */
  toolNames: string[]
  compactions: Array<{ trigger: string; instructions?: string }>
  /** What fs.stat answers for TRANSCRIPT (W2e precompute key); null: missing. */
  transcriptStat: { size: number; mtimeMs: number } | null
  /** fs.stat with `resolve`: a path here is a link to its value (null: it leads nowhere); any other path lands on itself. */
  links: Map<string, string | null>
  /** fs.stat with `resolve`: a path here is not there yet; the stat rejects `ENOENT: <path>`. */
  absent: Set<string>
  /** fs.stat with `resolve`: a path here rejects with this text (another errno, which may name the path). */
  statRejects: Map<string, string>
  /** Ops answered with a deny (the mod's call rejects): fault injection. */
  failing: Set<string>
  /** One-shot: the next call of this op waits for the promise, then rejects (a stalled, then failed, call). */
  stalls: Map<string, Promise<void>>
  /**
   * Optional, off by default (TRACK-25 W1 polish): when set, the next prompt.read waits for this promise, then
   * answers the draft as usual (a stalled, then successful, read). One-shot: cleared when taken.
   */
  promptReadHold?: Promise<void> | null
  /** How many prompt.read calls waited on promptReadHold. */
  promptReadHeld?: number
  /** plan:111, optional: a write to a path here waits for its promise, then succeeds. One-shot. */
  writeHolds?: Map<string, Promise<void>>
  /** Every path fs.read was asked for. */
  reads: string[]
  /** fs.list `mtimeMs` per path (W8 E); a path not here lists with 0. */
  mtimes: Map<string, number>
  /** Every path an `rm -f --` run removed (W8 E). */
  removed: string[]
}

export const TEMPLATE_SUFFIX = ['','skills','compact-crafter','reference','snapshot-template.md'].join('/')

/** Seats the world beneath the plugin; every op the mod calls is answered here. */
export function worldOf(on: On, over: Partial<World> = {}): World {
  const world: World = {
    files: new Map(),
    env: { HOME: fixturePath('home'), CONTEXT_HANDOFF_STATE_DIR: STATE, CONTEXT_HANDOFF_BRIEF_DIR: BRIEFS },
    sessionId: OLD,
    percent: 75,
    tokens: 750_000,
    draft: '',
    extractor: { exitCode: 0, stdout: FACTS },
    extractorRuns: [],
    clearRejects: false,
    clearSwitchesTo: NEW,
    compactAnswer: async () => ({ messages: [SUMMARY] }),
    stopBlock: null,
    dropPluginPrompts: false,
    relayOnStart: true, relayOnStop: true, backgroundTasks: [], sessionCrons: [],
    commands: [], commandRuns: [], submits: [], notes: [], runPrompts: [], fills: [], statuses: [], logs: [], tools: [], toolNames: [], compactions: [],
    transcriptStat: { size: 1_000_000, mtimeMs: 1_000 },
    links: new Map(), absent: new Set(), statRejects: new Map(), failing: new Set(), stalls: new Map(), reads: [], mtimes: new Map(), removed: [],
    ...over,
  }
  const asAny = on as unknown as (event: string, hook: (...args: any[]) => unknown) => void
  const relay = (event: 'SessionStart' | 'Stop') => {
    world.files.set(`${STATE}/relay/${world.sessionId}.json`, JSON.stringify({
      v: 1, event, session_id: world.sessionId,
      owner: world.env.CONTEXT_HANDOFF_OWNER ?? null,
      generation: world.env.CONTEXT_HANDOFF_ACTIVITY_GENERATION ?? null,
      observed_at: 0, transcript_path: TRANSCRIPT,
      background_tasks: event === 'Stop' ? world.backgroundTasks : null,
      session_crons: event === 'Stop' ? world.sessionCrons : null,
    }))
  }
  if (world.relayOnStart) relay('SessionStart')

  // The mod resolves the template relative to its own folder on disk, so it is matched by suffix.
  const templateOr = (path: string) => (path.endsWith(TEMPLATE_SUFFIX) ? TEMPLATE : world.files.get(path))
  asAny('fs.read', (_$: unknown, e: { path: string }) => {
    world.reads.push(e.path)
    // TRACK-25: 'template-read' (off by default) makes only the template read fail.
    if (world.failing.has('template-read') && e.path.endsWith(TEMPLATE_SUFFIX)) return { deny: `injected: EIO ${e.path}` }
    const text = templateOr(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  asAny('fs.exists', (_$: unknown, e: { path: string }) => {
    if (world.failing.has('kill-switch-check') && e.path === `${STATE}/DISABLED`) return { deny: 'injected: kill switch check' }
    return { value: templateOr(e.path) !== undefined || [...world.files.keys()].some(k => k.startsWith(`${e.path}/`)) }
  })
  asAny('fs.write', async (_$: unknown, e: { path: string; text: string }) => {
    if (world.failing.has('state-write') && e.path.startsWith(`${STATE}/sessions/`)) return { deny: `injected: EIO ${e.path}` }
    const hold = world.writeHolds?.get(e.path)
    if (hold !== undefined) {
      world.writeHolds?.delete(e.path)
      await hold
    }
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  asAny('fs.list', (_$: unknown, e: { path: string }) => ({
    value: [...world.files.keys()]
      .filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/'))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: world.mtimes.get(k) ?? 0, isLink: false })),
  }))
  asAny('fs.stat', (_$: unknown, e: { path: string; resolve?: boolean }) => {
    if (e.resolve === true && world.absent.has(e.path)) return { deny: `ENOENT: ${e.path}` }
    if (e.resolve === true && world.statRejects.has(e.path)) return { deny: world.statRejects.get(e.path) }
    if (e.resolve === true && e.path !== TRANSCRIPT) {
      const to = world.links.has(e.path) ? world.links.get(e.path) : e.path
      return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: world.links.has(e.path), ...(to === null || to === undefined ? {} : { realPath: to }) } }
    }
    const stat = e.path === TRANSCRIPT ? world.transcriptStat : null
    return stat === null
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, isLink: false, ...(e.resolve === true ? { realPath: e.path } : {}) } }
  })
  asAny('env.get', (_$: unknown, e: { name: string }) => ({ value: world.env[e.name] }))
  asAny('env.set', (_$: unknown, e: { name: string; value?: string }) => {
    world.env[e.name] = e.value
    return { value: undefined }
  })
  asAny('session.id', async () => {
    const stall = world.stalls.get('session.id')
    if (stall !== undefined) {
      world.stalls.delete('session.id')
      await stall
      return { deny: 'injected: stalled session.id' }
    }
    return world.failing.has('session.id') ? { deny: 'injected: session.id' } : { value: world.sessionId }
  })
  asAny('session.usage', () => world.failing.has('session.usage') ? { deny: 'injected: session.usage' } : ({
    value: { startedAt: 0, context: { tokens: world.tokens, window: 1_000_000, percent: world.percent } },
  }))
  asAny('prompt.read', () => {
    const hold = world.promptReadHold ?? null
    // Off by default: answered synchronously, exactly as before the hold existed.
    if (hold === null) return { value: { text: world.draft, cursor: world.draft.length } }
    world.promptReadHold = null
    world.promptReadHeld = (world.promptReadHeld ?? 0) + 1
    return hold.then(() => ({ value: { text: world.draft, cursor: world.draft.length } }))
  })
  asAny('process.run', (_$: unknown, e: { argv: string[] }) => {
    if (e.argv[0] === 'rm' && e.argv[1] === '-f' && e.argv[2] === '--' && world.failing.has('rm')) {
      return { value: { exitCode: 1, stdout: '', stderr: 'rm: injected failure', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'rm' && e.argv[1] === '-f' && e.argv[2] === '--') {
      for (const path of e.argv.slice(3)) {
        world.files.delete(path)
        world.removed.push(path)
      }
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'date') return { value: { exitCode: 0, stdout: '+0300\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'sh' && e.argv[2] === 'echo $PPID' && world.failing.has('pid-probe')) return { deny: 'injected: pid probe' }
    if (e.argv[0] === 'sh' && e.argv[2] === 'echo $PPID') return { value: { exitCode: 0, stdout: `${PID}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'sh' && String(e.argv[2]).includes('>> "$2"')) {
      // log.ts appendArgv: $1 the line, $2 the path.
      const path = e.argv[5] as string
      world.files.set(path, `${world.files.get(path) ?? ''}${e.argv[4]}\n`)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    world.extractorRuns.push([...e.argv])
    return { value: { stderr: '', ...world.extractor, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  asAny('tool.register', (_$: unknown, e: { name: string }) => {
    world.tools.push(e.name)
    return { value: { tool: `mcp__context-handoff__${e.name}` } }
  })
  asAny('tool.list', () => ({ value: world.toolNames.map(name => ({ name, description: '', mcp: true })) }))
  asAny('ui.status', (_$: unknown, e: { text?: string }) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  asAny('ui.log', (_$: unknown, e: { text: string }) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  asAny('ui.invalidate', () => ({ value: undefined }))
  asAny('command.run', (_$: unknown, e: { command: string; origin?: unknown }) => {
    world.commands.push(e.command)
    world.commandRuns.push({ command: e.command, origin: e.origin })
    // Only the clear is refused: the automatic run's own command.run(context-handoff:compact-crafter) still resolves.
    if (world.clearRejects && e.command === 'clear') throw new Error('clear refused')
    if (e.command === 'clear' && world.clearSwitchesTo) world.sessionId = world.clearSwitchesTo
    return { text: '' }
  })
  asAny('prompt.submit', (_$: unknown, e: { text: string; origin?: { kind: string } }) => {
    // Only plugin-submitted prompts are seeds; a test's own typed prompt (origin composer) is not recorded.
    if (e.origin?.kind !== 'plugin') return { text: e.text }
    if (e.text.startsWith('/context-handoff:compact-crafter automatic-run ')) {
      world.runPrompts.push(e.text)
      return { text: e.text }
    }
    world.submits.push(e.text)
    if (world.failing.has('prompt.submit')) throw new Error('injected: prompt.submit')
    return world.dropPluginPrompts ? { drop: 'lost' } : { text: e.text }
  })
  // 2.1.293 supports session.append in the test kit. Assert its actual note and fault explicitly.
  asAny('session.append', async (_$: unknown, e: { message: unknown }, next: (e: unknown) => Promise<any>) => {
    if (world.failing.has('session.append')) return { deny: 'injected: session.append' }
    const answer = await next(e)
    world.notes.push(answer.message)
    return answer
  })
  asAny('prompt.fill', (_$: unknown, e: { text: string }) => {
    world.fills.push(e.text)
    if (world.failing.has('prompt.fill-throws')) throw new Error('injected: prompt.fill')
    if (world.failing.has('prompt.fill')) return { isFilled: false } // the box was not filled (d.ts: a busy box)
    world.draft = e.text // the box now holds the filled text, as prompt.read would show it
    return { isFilled: true }
  })
  // `trigger` (plugin) and `messages` of a plugin's $.session.compact are the engine's (d.ts SessionCompactArgs);
  // the test kit hands the plugin's args here as given, so `trigger` is recorded as received.
  asAny('session.compact', async (_$: unknown, e: { trigger: string; instructions?: string }) => {
    world.compactions.push({ trigger: e.trigger, instructions: e.instructions })
    return world.compactAnswer()
  })
  asAny('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  asAny('session.end', (_$: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  asAny('turn.complete', (_$: unknown, e: { answer: string }) => {
    if (world.relayOnStop) relay('Stop')
    return { text: e.answer }
  })
  asAny('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  asAny('classic.Stop', (_$: unknown, e: { background_tasks?: unknown[]; session_crons?: unknown[]; agent_id?: string }) => {
    if (e.agent_id === undefined) {
      world.backgroundTasks = e.background_tasks ?? null
      world.sessionCrons = e.session_crons ?? null
      if (world.relayOnStop) relay('Stop')
    }
    return world.stopBlock === null ? {} : { block: world.stopBlock }
  })
  for (const name of ['SessionStart', 'PreCompact', 'SessionEnd']) asAny(`classic.${name}`, () => ({}))
  return world
}

/** The brief file the mod wrote (C3 name with the cycle suffix), if any; a skill snapshot beside it is not one. */
export function briefOf(world: World): { path: string; text: string } | null {
  const name = /^[0-9a-f-]{36}-\d{8}-\d{4}-\d+\.md$/
  for (const [path, text] of world.files) {
    if (path.startsWith(`${BRIEFS}/`) && name.test(path.slice(BRIEFS.length + 1))) return { path, text }
  }
  return null
}

export function logOf(world: World): string {
  return world.files.get(`${STATE}/handoff.log`) ?? ''
}

/** The target plugin's resource lookup, observed after a fixture handoff reads its template.
 * A test hook has its own plugin identity; its $.plugin.root is not the target's directory.
 */
export function packagedScripts(world: World): string {
  const template = world.reads.find(path => path.endsWith(TEMPLATE_SUFFIX))
  if (template === undefined) throw new Error('the fixture must exercise the packaged template lookup first')
  return `${template.slice(0, -TEMPLATE_SUFFIX.length)}/skills/compact-crafter/scripts`
}

export const SESSION_START = { cwd: fixturePath('work'), surface: 'terminal' as const, isInteractive: true }
export const TURN = { answer: 'All done.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' as const }
