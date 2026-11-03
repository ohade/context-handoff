// W7 Phase B (audit P4). Written red-first. Run with `claude plugin test <mod dir>`.
import { describe, expect, mock, test } from 'claude-code/testing'

import { logOf, SESSION_START, TRANSCRIPT, worldOf } from './fixtures/world'

type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

describe('[F] the pid probe says why it failed', () => {
  test('a pid probe that fails logs pid-probe-failed with the reason; the load goes on with a fresh owner', async ($, on) => {
    const world = worldOf(on, { failing: new Set(['pid-probe']) })
    const clock = mock.clock(on)
    await $.session.start(SESSION_START)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
    await settle(clock)
    const log = logOf(world)
    expect(log).toContain(' pid-probe-failed ')
    expect(log).toContain('injected: pid probe')
    expect(log).toContain(' loaded owner=')
  })
})
