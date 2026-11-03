import { DATA_ROUTE, DOMAIN_ROUTE, EXPLICIT_ROUTE } from '../fixtures/routing'

// FIXTURE: the seed avoids representative topic, data, command and peer routes.
import { describe, expect, test } from 'bun:test'

import { briefFileName, seedText } from '../../hooks/brief'

// Shared synthetic routes keep the seed independent of any private host policy.
// Representative peer names and instruction verbs.
const PEER_NAMES = ['codex', 'claude', 'gemini', 'grok', 'cursor', 'amq']
// A later peer name must not pair with one of these instruction verbs.
const PEER_VERBS = /(talk|discuss|consult|ask|route|coordinate|sync|work[\s]+with|use|instruct|tell|delegate|send)/i
// Additional words that would make the seed sound like a new request.
const BRIEF_WORDS = ['codex', 'review', 'audit', 'data', 'report']

const SEED = seedText(briefFileName('d3adbeef-0000-4abc-8def-0123456789ab', '20261004-2240', 1))

describe('seed line', () => {
  test('is one line', () => {
    expect(SEED.includes('\n')).toBe(false)
  })

  test('names the brief file', () => {
    expect(SEED).toContain('d3adbeef-0000-4abc-8def-0123456789ab-20261004-2240-1.md')
  })

  test('matches none of the representative routing fixtures', () => {
    expect(DOMAIN_ROUTE.test(SEED)).toBe(false)
    expect(DATA_ROUTE.test(SEED)).toBe(false)
    expect(EXPLICIT_ROUTE.test(SEED)).toBe(false)
  })

  test('names no peer, so the peer-discussion route cannot fire', () => {
    for (const name of PEER_NAMES) {
      expect([name, new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`, 'i').test(SEED)]).toEqual([name, false])
    }
  })

  test('also holds none of the peer verbs, so a later peer name cannot pair with it', () => {
    expect(SEED.match(PEER_VERBS)).toBeNull()
  })

  test('holds none of codex, review, audit, data, report', () => {
    for (const word of BRIEF_WORDS) expect([word, SEED.toLowerCase().includes(word)]).toEqual([word, false])
  })

  test('the checks catch a bad line (the spec is not vacuous)', () => {
    const bad = 'Please review the billing data and ask codex'
    expect(DATA_ROUTE.test(bad)).toBe(true)
    expect(DOMAIN_ROUTE.test(bad)).toBe(true)
    expect(EXPLICIT_ROUTE.test('/data-reader')).toBe(true)
    expect(bad.match(PEER_VERBS)).not.toBeNull()
  })
})
