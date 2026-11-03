// W2g engine test (Phase 2 live check), run with `claude plugin test <mod dir>`. Live, a fresh session
// gets no classic.SessionStart source=startup and no Stop before its first tool use, so the nudge's
// precompute logged `transcript path unknown`. The path now comes from the main classic.PostToolUse
// input that carries the nudge. The ordinary SessionStart relay now supplies it independently.
import { describe, expect, mock, test } from 'claude-code/testing'

import { nudgeText } from '../hooks/nudge'
import { logOf, SESSION_START, TRANSCRIPT, TURN, worldOf } from './fixtures/world'

type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

describe('W2g: the transcript path before the first Stop', () => {
  test('a fresh session whose first main tool result crosses the threshold logs precompute-done, not precompute-skipped', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
    world.tokens = 412_345
    world.percent = 41
    await $.session.start(SESSION_START)
    await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'keep going', turnId: TURN.turnId })
    const result = await $.tool.call({ tool: 'Bash', command: 'pwd', tool_use_id: 'x' })
    await settle(clock)
    expect(result.context).toEqual([nudgeText(412_345, 41)])
    const log = logOf(world)
    expect(log).not.toContain('precompute-skipped')
    expect(log).toContain('precompute-done')
  })

  test('a subagent tool result never sets the path: the main nudge after it still has none', async ($, on) => {
    const world = worldOf(on, { relayOnStart: false })
    const clock = mock.clock(on)
    on('classic.PostToolUse', () => ({}))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
    world.tokens = 412_345
    world.percent = 41
    await $.session.start(SESSION_START)
    await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'keep going', turnId: TURN.turnId })
    await $.classic.PostToolUse({
      tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 's', session_id: world.sessionId, transcript_path: TRANSCRIPT, agent_id: 'sub-1',
    })
    await $.tool.call({ tool: 'Bash', command: 'pwd', tool_use_id: 'x' })
    await settle(clock)
    expect(logOf(world)).toContain('precompute-skipped')
  })
})
