import { fixturePath } from '../fixtures/paths'

// the Stop record must reach the machine BEFORE the settings Stop hooks
// run (so the background-task and cron guards see this turn), and only the block cancel after.
// register.tsx dispatches stopRecord(e) before `next(e)` and stopBlockCancel(e, result) after it.
import { describe, expect, test } from 'bun:test'

import { stopBlockCancel, stopRecord } from '../../hooks/turns'

const T0 = 1_000_000

describe('[medium] Stop record before the settings hooks, block cancel after', () => {
  test('the record depends on the Stop input only', () => {
    expect(stopRecord({ background_tasks: [{}, {}], session_crons: [{}], transcript_path: fixturePath('t.jsonl') }))
      .toEqual({ type: 'stop', backgroundTasks: 2, runningSubagents: 0, sessionCrons: 1, transcriptPath: fixturePath('t.jsonl') })
    expect(stopRecord({})).toEqual({ type: 'stop', backgroundTasks: null, runningSubagents: 0, sessionCrons: null, transcriptPath: null })
  })

  test('a subagent Stop gives no record and no cancel', () => {
    expect(stopRecord({ agent_id: 'a', background_tasks: [{}] })).toBeNull()
    expect(stopBlockCancel({ agent_id: 'a' }, { block: 'x' }, T0)).toBeNull()
  })

  test('a settings Stop hook block cancels with reason stop-blocked; no block, no cancel', () => {
    expect(stopBlockCancel({}, { block: 'run the tests first' }, T0)).toEqual({ type: 'cancel', now: T0, reason: 'stop-blocked' })
    expect(stopBlockCancel({}, {}, T0)).toBeNull()
  })
})
