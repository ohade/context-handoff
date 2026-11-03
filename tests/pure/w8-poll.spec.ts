// only a rejected session id probe ends the cycle at once. A rejected
// `now` or `sleep` (a hot reload cancels a load's waits) rejects the poll, so the caller dispatches
// nothing. No red run against the old inline loop: the test kit's mock clock owns `clock.sleep`.
import { describe, expect, test } from 'bun:test'

import { pollForNewId } from '../../hooks/poll'
import type { PollHost } from '../../hooks/poll'

function host(ids: Array<string | Error>, sleepFails = false): PollHost & { slept: number } {
  let t = 0
  const h = {
    slept: 0,
    now: async () => t,
    sleep: async (ms: number) => {
      if (sleepFails) throw new Error('wait cancelled by a reload')
      h.slept += 1
      t += ms
    },
    sessionId: async () => {
      const next = ids.length > 1 ? ids.shift() : ids[0]
      if (next instanceof Error) throw next
      return next as string
    },
  }
  return h
}

describe('[W8 r1] the new-id poll', () => {
  test('a new id ends the poll with that id', async () => {
    expect(await pollForNewId(host(['old', 'old', 'new']), 'old', 5_000)).toEqual({ sessionId: 'new' })
  })

  test('the old id until the time runs out answers null after about 5 s of 250 ms sleeps', async () => {
    const h = host(['old'])
    expect(await pollForNewId(h, 'old', 5_000)).toEqual({ sessionId: null })
    expect(h.slept).toBe(20)
  })

  test('a rejected id probe answers failure with its error class and message', async () => {
    expect(await pollForNewId(host(['old', new Error('injected: session.id')]), 'old', 5_000)).toEqual({ failure: 'Error: injected: session.id' })
  })

  test('a rejected sleep rejects the poll instead of answering failure', async () => {
    await expect(pollForNewId(host(['old'], true), 'old', 5_000)).rejects.toThrow('wait cancelled by a reload')
  })
})
