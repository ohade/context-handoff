import { fixturePath } from './fixtures/paths'

// Engine coverage for armed-run guards. Run with `claude plugin test <plugin dir>`.
// 1. The armed-window tool.call guard fails CLOSED: a guard that throws inside a run turn denies.
// 2. The allowlist judges where a path LANDS: the hook resolves it with $.fs.stat({ resolve: true }).
// 3. The other gating hooks fail SAFE: the event goes on, and the failure is logged.
// 4. handoff_now's automatic door checks the path before it reads anything.
import { describe, expect, mock, test } from 'claude-code/testing'

import { BRIEFS, logOf, NEW, OLD, packagedScripts, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, SUMMARY, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

type Eng = any
type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
const TOOL = 'mcp__context-handoff__handoff_now'
const CYCLE = `${OLD}#1`
const OWN = { kind: 'plugin', name: 'context-handoff' }
const RUN_DENY = 'context-handoff automatic run: '

async function startSession($: Eng, world: World): Promise<void> {
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
}

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

/** A typed turn ends over the threshold, the skill run starts, and its bound turn is current. */
async function inRunTurn($: Eng, world: World, clock: Clock): Promise<void> {
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await startSession($, world)
  await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'keep going', turnId: TURN.turnId })
  await $.turn.complete(TURN)
  await settle(clock)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  await $.prompt.submit({ text: RUN_PROMPT(CYCLE), wait: false, origin: OWN })
  await $.turn.start({ text: RUN_TURN_TEXT(CYCLE), turnId: 't2' })
}

describe('[B1] the armed-window guard fails closed', () => {
  test('a guard that throws inside the run turn denies the call', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await inRunTurn($, world, clock)
    world.failing.add('session.id')
    const call = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git push origin main' })
    expect(call.result, 'the tool beneath never ran').toBeUndefined()
    expect(String(call.deny)).toStartWith(RUN_DENY)
    await settle(clock) // the .catch logs without awaiting (its grace is 1 s)
    expect(logOf(world)).toContain(' hook-failed tool.call ')
  })
})

describe('[J] the window judges where a path lands', () => {
  test('a Read or a check-snapshot.py of a snapshot that links out of the brief folder is denied', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await inRunTurn($, world, clock)
    const read = async (id: string) => (await $.tool.call({ tool: 'Read', tool_use_id: id, file_path: RUN_SNAPSHOT })).deny
    const queued = await $.tool.call({ tool: TOOL, tool_use_id: 'packaged-template', snapshot_path: RUN_SNAPSHOT })
    expect(String(queued.result)).toStartWith('handing off at the end of this turn')
    const SCRIPTS = packagedScripts(world)
    const check = async (id: string) => (await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `python3 ${SCRIPTS}/check-snapshot.py ${RUN_SNAPSHOT}` })).deny
    expect(await read('r1')).toBeUndefined()
    expect(await check('b1')).toBeUndefined()
    world.links.set(RUN_SNAPSHOT, fixturePath('home/.ssh/id_rsa'))
    expect(String(await read('r2'))).toContain('Read is allowed only under')
    expect(String(await check('b2'))).toStartWith(RUN_DENY)
    world.links.set(RUN_SNAPSHOT, null)
    expect(String(await read('r3')), 'a link that leads nowhere').toContain('Read is allowed only under')
  })

  test('a Write through a brief folder that leads nowhere is denied; a new snapshot in the real folder passes', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await inRunTurn($, world, clock)
    const fresh = `${BRIEFS}/${OLD}-new.md`
    const write = async (id: string) => (await $.tool.call({ tool: 'Write', tool_use_id: id, file_path: fresh, content: 'x' })).deny
    world.absent.add(fresh)
    expect(await write('w1'), 'not there yet: the stat rejects ENOENT and the file is placed by its folder').toBeUndefined()
    await settle(clock)
    expect(logOf(world)).toContain(` auto-run-stat ${fresh} `)
    world.links.set(BRIEFS, null)
    expect(String(await write('w2'))).toContain('Write is allowed only to')
    world.links.delete(BRIEFS)
    const named = `${BRIEFS}/${OLD}-ENOENT.md`
    world.statRejects.set(named, `EACCES: permission denied, stat '${named}'`)
    const third = await $.tool.call({ tool: 'Write', tool_use_id: 'w3', file_path: named, content: 'x' })
    expect(String(third.deny), 'ENOENT in the chosen name is not a missing file').toContain('Write is allowed only to')
  })
})

describe('[B3] the other gating hooks fail safe', () => {
  test('classic.Stop: a hook failure lets the event go on unblocked and is logged', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await startSession($, world)
    const result = await $.classic.Stop({ stop_hook_active: false, background_tasks: 'not a list', transcript_path: TRANSCRIPT, session_id: world.sessionId })
    expect(result.block).toBeUndefined()
    await settle(clock)
    expect(logOf(world)).toContain(' hook-failed classic.Stop ')
  })

  test('session.compact: a hook failure never skips the compaction and is logged', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await startSession($, world)
    world.failing.add('session.usage')
    const result = await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
    expect(result.skip).toBeUndefined()
    expect(world.commands, 'no automatic run either').toEqual([])
    await settle(clock)
    expect(logOf(world)).toContain(' hook-failed session.compact ')
  })
})

describe('[I] the automatic door checks the path before it reads', () => {
  test('a snapshot path outside the brief folder, or named for another session, is refused unread', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await inRunTurn($, world, clock)
    const other = `${BRIEFS}/${NEW}-x.md`
    world.files.set(other, SNAPSHOT_TEXT())
    const outside = await $.tool.call({ tool: TOOL, tool_use_id: 'h1', snapshot_path: fixturePath('home/.ssh/id_rsa') })
    expect(outside.result).toBe(`snapshot invalid: snapshot must be directly under ${BRIEFS}`)
    const named = await $.tool.call({ tool: TOOL, tool_use_id: 'h2', snapshot_path: other })
    expect(String(named.result)).toStartWith('snapshot invalid: the file name must start with the current session id')
    expect(world.reads).not.toContain(fixturePath('home/.ssh/id_rsa'))
    expect(world.reads).not.toContain(other)
  })
})

describe('[B1 r1] outside a run a failing guard passes the call on', () => {
  test('handoff_now in a typed /compact-crafter turn whose hook throws reaches the tool beneath; nothing is denied', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const snap = fixturePath('snap/s.md')
    world.files.set(snap, SNAPSHOT_TEXT())
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await startSession($, world)
    await $.prompt.submit({ text: '/compact-crafter', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: '/compact-crafter', turnId: TURN.turnId })
    world.failing.add('session.usage')
    const call = await $.tool.call({ tool: TOOL, tool_use_id: 'h1', snapshot_path: snap })
    expect(call.deny).toBeUndefined()
    expect(call.result, 'the call went on beneath').toBe('ran')
    await settle(clock)
    expect(logOf(world)).toContain(' hook-failed tool.call ')
  })
})

describe('[security review] the guard keeps what it decided when the call started', () => {
  test('a Write to a name that is listed in the brief folder but does not stat (a dangling link) is denied', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await inRunTurn($, world, clock)
    const dangling = `${BRIEFS}/${OLD}-planted.md`
    world.absent.add(dangling)
    world.files.set(dangling, '')
    const call = await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: dangling, content: 'x' })
    expect(String(call.deny)).toContain('Write is allowed only to')
  })

  test('the listing is compared the way a case-insensitive file system resolves names (case, Unicode form)', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await inRunTurn($, world, clock)
    const write = async (file_path: string, id: string) => (await $.tool.call({ tool: 'Write', tool_use_id: id, file_path, content: 'x' })).deny
    const lower = `${BRIEFS}/${OLD}-planted.md`
    world.absent.add(lower)
    world.files.set(`${BRIEFS}/${OLD}-PLANTED.md`, '')
    expect(String(await write(lower, 'w1')), 'a link planted under another case').toContain('Write is allowed only to')
    const composed = `${BRIEFS}/${OLD}-caf\u00e9.md`
    world.absent.add(composed)
    world.files.set(`${BRIEFS}/${OLD}-cafe\u0301.md`, '')
    expect(String(await write(composed, 'w2')), 'a link planted in the other Unicode form').toContain('Write is allowed only to')
  })

  test('a link planted as capital sharp s (APFS folds it to ss) counts as listed for an ASCII target', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await inRunTurn($, world, clock)
    const target = `${BRIEFS}/${OLD}-ssnap.md`
    world.absent.add(target)
    world.files.set(`${BRIEFS}/${OLD}-\u1e9enap.md`, '')
    const call = await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: target, content: 'x' })
    expect(String(call.deny)).toContain('Write is allowed only to')
  })

  test('a link planted under a name APFS folds to the target (long s for s) still counts as listed', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await inRunTurn($, world, clock)
    const target = `${BRIEFS}/${OLD}-snap.md`
    world.absent.add(target)
    world.files.set(`${BRIEFS}/${OLD}-\u017fnap.md`, '')
    const call = await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: target, content: 'x' })
    expect(String(call.deny)).toContain('Write is allowed only to')
  })

  test('a guard that fails after its run turn ended still denies: the window is the one the call started in', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await inRunTurn($, world, clock)
    let release = (): void => {}
    world.stalls.set('session.id', new Promise<void>(resolve => { release = resolve }))
    const pending = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git push origin main' })
    await $.turn.complete({ ...TURN, turnId: 't2' })
    release()
    const call = await pending
    expect(call.result, 'the tool beneath never ran').toBeUndefined()
    expect(String(call.deny)).toStartWith(RUN_DENY)
  })
})
