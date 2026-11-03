import { fixturePath } from '../fixtures/paths'

// W2g round 1: one predicate decides whether a transcript record would change the state, so the
// register pre-filter dispatches (and persists) nothing that onTranscriptSeen would ignore. Red-first.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import { acceptsTranscript, initialState, step } from '../../hooks/machine'

const SESSION = '11111111-aaaa-4bbb-8ccc-000000000001'
const OTHER = '22222222-aaaa-4bbb-8ccc-000000000002'
const PATH = fixturePath(`home/.claude/projects/p/${SESSION}.jsonl`)

describe('acceptsTranscript', () => {
  const config = resolveConfig({}, {}).config

  test('true only for the current session while no path is known', () => {
    const s0 = initialState(SESSION, 0, 'owner')
    expect(acceptsTranscript(s0, SESSION)).toBe(true)
    expect(acceptsTranscript(s0, OTHER)).toBe(false)
    const known = { ...s0, transcriptPath: PATH }
    expect(acceptsTranscript(known, SESSION)).toBe(false)
    expect(acceptsTranscript(known, OTHER)).toBe(false)
  })

  test('onTranscriptSeen changes the state exactly when the predicate accepts', () => {
    const s0 = initialState(SESSION, 0, 'owner')
    for (const state of [s0, { ...s0, transcriptPath: PATH }]) {
      for (const sessionId of [SESSION, OTHER]) {
        const next = step(state, { type: 'transcriptSeen', sessionId, transcriptPath: fixturePath('x.jsonl') }, config).state
        expect(next !== state).toBe(acceptsTranscript(state, sessionId))
      }
    }
  })
})
