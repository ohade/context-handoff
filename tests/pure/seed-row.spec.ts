import { fixturePath } from '../fixtures/paths'

// 1. A refused $.session.append ({deny}) is reported as refused, not as appended.
// 2. The model-only row carries only fixed mod text plus the brief path (pinned), so the
//    extractor can recognise and skip it (see scripts/tests/test_transcript_facts.py).
import { describe, expect, test } from 'bun:test'

import { appendOutcome, seedNote, SEED_NOTE_OPENING } from '../../hooks/brief'

describe('[low 1] a refused append is not logged as success', () => {
  test('a deny result is refused with its reason; a stored row is ok with its id', () => {
    expect(appendOutcome({ deny: 'policy' })).toEqual({ denied: 'policy' })
    expect(appendOutcome({ message: { type: 'user', content: [] }, uuid: 'u-1' })).toEqual({ ok: true, uuid: 'u-1' })
    expect(appendOutcome(undefined)).toEqual({ denied: 'no result' })
  })
})

describe('[low 2] the model-only row is fixed mod text plus the path', () => {
  test('seedNote is exactly the fixed opening, the path, and the fixed framing', () => {
    const path = fixturePath('Users/x/.claude/state/compact-handoffs/abc-20261005-1200.md')
    expect(seedNote(path)).toBe(
      `${SEED_NOTE_OPENING}${path}. Read all of it first. Its last section, written by the handoff mod, says how to treat the sections above it; follow that section.`,
    )
    expect(SEED_NOTE_OPENING).toBe('The handoff brief is at ')
  })
})
