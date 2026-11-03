import { fixturePath } from '../fixtures/paths'

// W2g item 2 (Phase 2 live check): the transcript path is known before the first Stop record.
// Written red-first.
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'
import { transcriptRecord } from '../../hooks/turns'

const SESSION = '11111111-aaaa-4bbb-8ccc-000000000001'
const OTHER = '22222222-aaaa-4bbb-8ccc-000000000002'
const PATH = fixturePath(`home/.claude/projects/p/${SESSION}.jsonl`)
const OTHER_PATH = fixturePath(`home/.claude/projects/p/${OTHER}.jsonl`)

describe('item 2: the transcript path from a main hook input', () => {
  const config = resolveConfig({}, {}).config

  test('a main-session input (no agent_id) gives a transcriptSeen record; a subagent input or no path gives none', () => {
    expect(transcriptRecord({ session_id: SESSION, transcript_path: PATH })).toEqual({ type: 'transcriptSeen', sessionId: SESSION, transcriptPath: PATH })
    expect(transcriptRecord({ session_id: SESSION, transcript_path: PATH, agent_id: 'a1' })).toBeNull()
    expect(transcriptRecord({ session_id: SESSION })).toBeNull()
    expect(transcriptRecord({ session_id: SESSION, transcript_path: '' })).toBeNull()
    expect(transcriptRecord({ transcript_path: PATH })).toBeNull()
  })

  test('the current session\'s path is recorded when none is known', () => {
    const s0 = initialState(SESSION, 0, 'owner')
    const { state, effects } = step(s0, { type: 'transcriptSeen', sessionId: SESSION, transcriptPath: PATH }, config)
    expect(state.transcriptPath).toBe(PATH)
    expect(effects).toEqual([])
  })

  test('another session\'s path is never recorded, and a known path is never overwritten by it', () => {
    const s0 = initialState(SESSION, 0, 'owner')
    expect(step(s0, { type: 'transcriptSeen', sessionId: OTHER, transcriptPath: OTHER_PATH }, config).state.transcriptPath).toBeNull()
    const known = step(s0, { type: 'transcriptSeen', sessionId: SESSION, transcriptPath: PATH }, config).state
    expect(step(known, { type: 'transcriptSeen', sessionId: OTHER, transcriptPath: OTHER_PATH }, config).state.transcriptPath).toBe(PATH)
    expect(step(known, { type: 'transcriptSeen', sessionId: SESSION, transcriptPath: OTHER_PATH }, config).state.transcriptPath).toBe(PATH)
  })

  test('the phase and the rest of the state are untouched', () => {
    const s0 = initialState(SESSION, 0, 'owner')
    const { state } = step(s0, { type: 'transcriptSeen', sessionId: SESSION, transcriptPath: PATH }, config)
    expect({ ...state, transcriptPath: null }).toEqual(s0)
  })
})
