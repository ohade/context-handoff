// W2e engine tests (Phase 2, User's two stages), run with `claude plugin test <mod dir>`.
// Stage 1: a native main tool result at the threshold carries ONE nudge in context
// and starts the extractor precompute. Stage 2: the run starts only at a clean
// turn end, or at the ceiling (never while background tasks run). Written red-first.
import { describe, expect, mock, test } from 'claude-code/testing'

import { HANDOFF_NOW_QUEUED } from '../hooks/handoff-now'
import { nudgeText, PRECOMPUTE_REUSE_BYTES } from '../hooks/nudge'
import { briefOf, FACTS, logOf, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

type Eng = any
type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
const CYCLE = `${OLD}#1`
const OWN = { kind: 'plugin', name: 'context-handoff' }
const TOOL_RESULT = { tool: 'Bash', command: 'pwd', tool_use_id: 'x' }

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

async function stop($: Eng, world: World, background_tasks: unknown[] = []): Promise<void> {
  await $.classic.Stop({ stop_hook_active: false, background_tasks, session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
}

/** A session, a typed turn t1, and one main tool result at 412k tokens: the nudge. */
async function nudgedTurn($: Eng, on: Eng, world: World, clock: Clock): Promise<{ context?: string[] }> {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  world.tokens = 412_345
  world.percent = 41
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.session.start(SESSION_START)
  await stop($, world)
  await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'keep going', turnId: TURN.turnId })
  const result = await $.tool.call(TOOL_RESULT)
  await settle(clock)
  return result
}

describe('stage 1: the nudge', () => {
  test('the first main tool result at the threshold carries the one nudge; the next does not; no run yet', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const first = await nudgedTurn($, on, world, clock)
    expect(first.context).toEqual([nudgeText(412_345, 41)])
    const second = await $.tool.call(TOOL_RESULT)
    expect(second.context ?? []).toEqual([])
    expect(world.commands).toEqual([])
    expect(logOf(world).split('\n').filter(l => l.includes(' nudged '))).toHaveLength(1)
  })

  test('below the threshold nothing is added', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
    world.tokens = 399_999
    await $.session.start(SESSION_START)
    await stop($, world)
    const result = await $.tool.call(TOOL_RESULT)
    await settle(clock)
    expect(result.context ?? []).toEqual([])
    expect(logOf(world)).not.toContain(' nudged ')
  })
})

describe('stage 2: the clean turn end', () => {
  test('a clean turn end after the nudge starts the run', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    await stop($, world)
    await $.turn.complete(TURN)
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  })

  test('a draft makes it wait: clean-wait, no run', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    world.draft = 'half typed'
    await stop($, world)
    await $.turn.complete(TURN)
    await settle(clock)
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain(' clean-wait draft-in-prompt-box ')
  })

  test('a prompt typed over the turn makes it wait: clean-wait pending-typed-prompt', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    await $.prompt.submit({ text: 'and then this', wait: true, turnId: TURN.turnId, origin: { kind: 'composer' } })
    await stop($, world)
    await $.turn.complete(TURN)
    await settle(clock)
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain(' clean-wait pending-typed-prompt ')
  })

  test('a running subagent makes it wait, and at the ceiling it still waits: ceiling-waiting-bg', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    world.tokens = 600_000
    await stop($, world, [{ id: 'a1', type: 'subagent', status: 'running', description: 'x' }])
    await $.turn.complete(TURN)
    await settle(clock)
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain(' ceiling-waiting-bg 600000 tokens >= ceiling 500000; background-tasks (1; 1 subagent)')
  })

  test('at the ceiling a draft still holds the run: ceiling-waiting-user, no run', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    world.tokens = 500_000
    world.draft = 'half typed'
    await stop($, world)
    await $.turn.complete(TURN)
    await settle(clock)
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain(' ceiling-waiting-user 500000 tokens >= ceiling 500000; draft-in-prompt-box')
  })
})

describe('the precompute', () => {
  async function toHandoffNow($: Eng, on: Eng, world: World, clock: Clock, grow: number) {
    await nudgedTurn($, on, world, clock)
    expect(world.extractorRuns).toHaveLength(1)
    expect(logOf(world)).toContain(' precompute-done ')
    await stop($, world)
    await $.turn.complete(TURN)
    await settle(clock)
    await $.prompt.submit({ text: RUN_PROMPT(CYCLE), wait: false, origin: OWN })
    await $.turn.start({ text: RUN_TURN_TEXT(CYCLE), turnId: 't2' })
    world.transcriptStat = { size: 1_000_000 + grow, mtimeMs: 2_000 }
    return $.tool.call({ tool: 'mcp__context-handoff__handoff_now', tool_use_id: 'tu-run', snapshot_path: RUN_SNAPSHOT })
  }

  test('the nudge runs the extractor in the background; the run reuses it while the transcript grew less than the bound', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const answer = await toHandoffNow($, on, world, clock, PRECOMPUTE_REUSE_BYTES - 1)
    expect(String(answer.result)).toStartWith(HANDOFF_NOW_QUEUED)
    expect(world.extractorRuns).toHaveLength(1)
    expect(logOf(world)).toContain(` facts-reused grew ${PRECOMPUTE_REUSE_BYTES - 1} bytes`)
  })

  test('past the bound the brief reruns the extractor', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const answer = await toHandoffNow($, on, world, clock, PRECOMPUTE_REUSE_BYTES)
    expect(String(answer.result)).toStartWith(HANDOFF_NOW_QUEUED)
    expect(world.extractorRuns).toHaveLength(2)
    expect(logOf(world)).toContain(` facts-rerun grew ${PRECOMPUTE_REUSE_BYTES} bytes`)
  })

  test('W2e r2 [medium]: a prompt typed after the nudge invalidates the precompute; the brief carries the newest typed prompt', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    expect(world.extractorRuns).toHaveLength(1)
    // The user types while the nudged turn runs: that turn end waits on the pending prompt.
    await $.prompt.submit({ text: 'and then this', wait: true, turnId: TURN.turnId, origin: { kind: 'composer' } })
    await stop($, world)
    await $.turn.complete(TURN)
    await settle(clock)
    expect(logOf(world)).toContain(' clean-wait pending-typed-prompt ')
    // The typed prompt's own turn runs and ends clean: the run starts.
    await $.turn.start({ text: 'and then this', turnId: 't3' })
    world.extractor = { exitCode: 0, stdout: FACTS.replace('### Last user request\n- none', '### Last user request\n- and then this') }
    await stop($, world)
    await $.turn.complete({ ...TURN, turnId: 't3' })
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    await $.prompt.submit({ text: RUN_PROMPT(CYCLE), wait: false, origin: OWN })
    await $.turn.start({ text: RUN_TURN_TEXT(CYCLE), turnId: 't4' })
    world.transcriptStat = { size: 1_040_000, mtimeMs: 2_000 }
    const answer = await $.tool.call({ tool: 'mcp__context-handoff__handoff_now', tool_use_id: 'tu-run', snapshot_path: RUN_SNAPSHOT })
    expect(String(answer.result)).toStartWith(HANDOFF_NOW_QUEUED)
    expect(briefOf(world)?.text).toContain('- and then this')
    expect(world.extractorRuns).toHaveLength(2)
    expect(logOf(world)).toContain(' facts-rerun no precompute')
  })

  test('a failed precompute only logs; the brief reruns the extractor', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    world.extractor = { exitCode: 1, stdout: '' }
    await nudgedTurn($, on, world, clock)
    expect(logOf(world)).toContain(' precompute-failed ')
    expect(world.commands).toEqual([])
  })
})

// CC-177 (User, 2026-10-09): an AMQ doorbell is typed into the composer by the wake injector. It is a
// wake-up only (the message stays in the AMQ inbox), so it must not make the turn end unclean.
const DOORBELL = ': AMQ doorbell run amq drain --include-body then act on it'

describe('CC-177: AMQ doorbells', () => {
  test('a doorbell typed over the turn does not make it wait: the run starts', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    await $.prompt.submit({ text: DOORBELL, wait: true, turnId: TURN.turnId, origin: { kind: 'composer' } })
    await stop($, world)
    await $.turn.complete(TURN)
    await settle(clock)
    expect(logOf(world)).not.toContain(' clean-wait pending-typed-prompt ')
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  })

  test('a real message that quotes the doorbell still makes it wait', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    await $.prompt.submit({ text: `${DOORBELL} and also check the tests`, wait: true, turnId: TURN.turnId, origin: { kind: 'composer' } })
    await stop($, world)
    await $.turn.complete(TURN)
    await settle(clock)
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain(' clean-wait pending-typed-prompt ')
  })
})
