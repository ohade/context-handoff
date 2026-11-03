import { errorText } from './errors'

// The new-id poll after a clear (W8 r1), kept apart from `$` so its failure handling is testable:
// the test kit's mock clock owns `clock.sleep`, so an engine test cannot make a sleep reject.

export type PollHost = {
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  sessionId: () => Promise<string>
}

/** `sessionId` null: still the old id when the time ran out. `failure`: the id probe rejected. */
export type PollResult = { sessionId: string | null } | { failure: string }

/**
 * Reads the session id every 250 ms until it differs from `oldSessionId` or `withinMs` has passed.
 * A rejected id probe answers `{ failure }`, so the caller ends the cycle at once. A rejected `now`
 * or `sleep` rejects this promise instead (a hot reload cancels a load's pending waits): the caller
 * dispatches nothing, and the clear deadline or the next load's reload recovery ends the cycle.
 */
export async function pollForNewId(host: PollHost, oldSessionId: string, withinMs: number): Promise<PollResult> {
  const until = (await host.now()) + withinMs
  while ((await host.now()) < until) {
    let seen: string
    try {
      seen = await host.sessionId()
    } catch (error) {
      return { failure: errorText(error) }
    }
    if (seen !== oldSessionId) return { sessionId: seen }
    await host.sleep(250)
  }
  return { sessionId: null }
}
