import { fixturePath } from './fixtures/paths'

// FIXTURE: successful native tool results carry the nudge, without PostToolUse.
import { expect, mock, test } from 'claude-code/testing'

import { nudgeText } from '../hooks/nudge'
import { OLD, SESSION_START, TRANSCRIPT, worldOf } from './fixtures/world'

test('native main-loop result keeps its context and carries one nudge without classic PostToolUse', async ($, on) => {
  const world = worldOf(on, { tokens: 412_345, percent: 41 })
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, context: ['existing'], ref: 42 }))
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: OLD })

  const first = await $.tool.call({ tool: 'Bash', command: 'pwd' })
  const second = await $.tool.call({ tool: 'Bash', command: 'pwd' })

  expect(first.context).toEqual(['existing', nudgeText(412_345, 41)])
  expect(first.ref).toBe(42)
  expect(second.context).toEqual(['existing'])
  expect(world.commands).toEqual([])
})

test('native refusal and error results stay unchanged and never nudge', async ($, on) => {
  worldOf(on, { tokens: 412_345, percent: 41 })
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'managed refusal' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'read failed', isError: true, context: ['keep the error context'] }))
  await $.session.start(SESSION_START)

  expect(await $.tool.call({ tool: 'Bash', command: 'pwd' })).toEqual({ deny: 'managed refusal' })
  const failed = await $.tool.call({ tool: 'Read', file_path: fixturePath('missing') })
  expect(failed.isError).toBe(true)
  expect(failed.context).toEqual(['keep the error context'])
})
