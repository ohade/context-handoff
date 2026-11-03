import { fixturePath } from '../fixtures/paths'

// ReviewWatch (reviews.ts): what register.tsx does with each read of the Plannotator store: one log line
// when the answer changes, and one pinned notice per session (unknown twice in a row, or a hold past the ceiling).
import { describe, expect, test } from 'bun:test'

import { ReviewWatch } from '../../hooks/reviews'
import type { ReviewRead } from '../../hooks/reviews'

const STORE = fixturePath('pn-store/plannotator_*.json')
const open = (count: number): ReviewRead => ({ count, storePath: STORE })
const unknown = (errorClass = 'no-launches-array'): ReviewRead => ({ unknown: true, errorClass, storePath: STORE })
const UNKNOWN_NOTICE = `context-handoff: Plannotator state is unknown (no-launches-array), so the handoff waits; store: ${STORE}`

describe('ReviewWatch log lines', () => {
  test('logs the first read and every change, naming the store path; a repeat logs nothing', () => {
    const w = new ReviewWatch()
    expect(w.observe('s1', open(0)).log).toBe(`count=0 store=${STORE}`)
    expect(w.observe('s1', open(0)).log).toBeNull()
    expect(w.observe('s1', open(2)).log).toBe(`count=2 store=${STORE}`)
    expect(w.observe('s1', unknown('EACCES')).log).toBe(`unknown errorClass=EACCES store=${STORE}`)
    expect(w.observe('s1', unknown('EACCES')).log).toBeNull()
  })
})

describe('ReviewWatch notices', () => {
  test('one unknown read pins nothing; two in a row pin the notice once; a third pins nothing', () => {
    const w = new ReviewWatch()
    expect(w.observe('s1', unknown()).notice).toBeNull()
    expect(w.observe('s1', unknown()).notice).toBe(UNKNOWN_NOTICE)
    expect(w.observe('s1', unknown()).notice).toBeNull()
  })

  test('a readable answer between two unknown reads resets the streak', () => {
    const w = new ReviewWatch()
    w.observe('s1', unknown())
    w.observe('s1', open(0))
    expect(w.observe('s1', unknown()).notice).toBeNull()
    expect(w.observe('s1', unknown()).notice).toBe(UNKNOWN_NOTICE)
  })

  test('a hold past the ceiling pins one notice naming the reason and the store path', () => {
    const w = new ReviewWatch()
    expect(w.held('s1', 'plannotator-review-open (1)', STORE)).toBe(`context-handoff: plannotator-review-open (1) holds the handoff past the ceiling; store: ${STORE}`)
    expect(w.held('s1', 'plannotator-review-open (1)', STORE)).toBeNull()
  })

  // the notice says "so the handoff waits", which is true only at a cycle start.
  test('reads after the cycle started (watchdog, pre-clear) neither count toward nor reset the unknown streak', () => {
    const w = new ReviewWatch()
    expect(w.observe('s1', unknown(), 'in-cycle').notice).toBeNull()
    expect(w.observe('s1', unknown(), 'in-cycle').notice).toBeNull()
    expect(w.observe('s1', unknown()).notice).toBeNull()
    expect(w.observe('s1', open(0), 'in-cycle').notice).toBeNull()
    expect(w.observe('s1', unknown()).notice).toBe(UNKNOWN_NOTICE)
  })

  test('one notice per session across both kinds; a new session may pin again', () => {
    const w = new ReviewWatch()
    expect(w.held('s1', 'plannotator-review-open (1)', STORE)).not.toBeNull()
    w.observe('s1', unknown())
    expect(w.observe('s1', unknown()).notice).toBeNull()
    w.observe('s2', unknown())
    expect(w.observe('s2', unknown()).notice).toBe(UNKNOWN_NOTICE)
  })
})
