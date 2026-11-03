import { fixturePath } from '../fixtures/paths'

// The Plannotator open-review reader (hooks/reviews.ts): total, never throwing, read-only.
// Every case runs against an in-memory file tree; no test reads the real store.
// "Open" = a launches[] record of this session whose dir holds `stdin`, with no `settled/` or with
// `settled/` but no `settled/delivered` (Plannotator 0.28.7 launch.ts:56, controller.ts:217).
import { describe, expect, test } from 'bun:test'

import { openPlannotatorReviews, resolveReviewStoreDir } from '../../hooks/reviews'
import type { ReviewFs } from '../../hooks/reviews'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const OTHER = '33333333-aaaa-4bbb-8ccc-000000000003'
const STORE = fixturePath('store')
const GLOB = `${STORE}/plannotator_*.json`

type Tree = Map<string, string>

function fsOf(tree: Tree, opts: { throwOn?: (op: string, path: string) => boolean; calls?: string[] } = {}): ReviewFs {
  const guard = (op: string, path: string) => {
    opts.calls?.push(`${op} ${path}`)
    if (opts.throwOn?.(op, path)) throw Object.assign(new Error(`injected ${op} ${path} bridgeToken=SECRET`), { code: 'EIO' })
  }
  return {
    exists: async path => (guard('exists', path), tree.has(path) || [...tree.keys()].some(k => k.startsWith(`${path}/`))),
    read: async path => {
      guard('read', path)
      const text = tree.get(path)
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    },
    list: async path => {
      guard('list', path)
      return [...tree.keys()]
        .filter(k => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'))
        .map(k => ({ name: k.slice(path.length + 1), kind: 'file' }))
    },
  }
}

type Rec = { id: string; sessionId: string; dir: string; closedByAgent?: boolean }
const rec = (id: string, sessionId = SID, extra: Partial<Rec> = {}): Rec => ({ id, sessionId, dir: fixturePath(`launch/${id}`), ...extra })

/** A store file with these launch records (plus a token field the reader must never log). */
function store(tree: Tree, records: Rec[], name = 'plannotator_plannotator-aaaa.json'): Tree {
  tree.set(`${STORE}/${name}`, JSON.stringify({ approvals: [], launches: records.map(r => ({ ...r, bridgeToken: 'SECRET' })) }))
  return tree
}

/** A launch folder: `stdin`, and optionally `settled/` with `delivered`, `reported` or neither. */
function launch(tree: Tree, id: string, state: 'open' | 'settled-delivered' | 'settled-reported' | 'claimed' | 'cleaned'): Tree {
  const dir = fixturePath(`launch/${id}`)
  if (state !== 'cleaned') tree.set(`${dir}/stdin`, '{}')
  if (state === 'claimed' || state === 'settled-delivered' || state === 'settled-reported') tree.set(`${dir}/settled/by`, 'x')
  if (state === 'settled-delivered') tree.set(`${dir}/settled/delivered`, '1')
  if (state === 'settled-reported') tree.set(`${dir}/settled/reported`, '1')
  return tree
}

describe('openPlannotatorReviews: counts', () => {
  test('an open launch of this session counts 1 and names the store path', async () => {
    const tree = launch(store(new Map(), [rec('pn-1')]), 'pn-1', 'open')
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 1, storePath: GLOB })
  })

  test('a delivered decision (settled/delivered) is not open', async () => {
    const tree = launch(store(new Map(), [rec('pn-1')]), 'pn-1', 'settled-delivered')
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 0, storePath: GLOB })
  })

  test('a stranded decision Plannotator already reported (settled/reported) is not open', async () => {
    const tree = launch(store(new Map(), [rec('pn-1')]), 'pn-1', 'settled-reported')
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 0, storePath: GLOB })
  })

  test('claimed but not delivered (settled/ without delivered) still counts as open', async () => {
    const tree = launch(store(new Map(), [rec('pn-1')]), 'pn-1', 'claimed')
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 1, storePath: GLOB })
  })

  test('closedByAgent: true still counts as open', async () => {
    const tree = launch(store(new Map(), [rec('pn-1', SID, { closedByAgent: true })]), 'pn-1', 'open')
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 1, storePath: GLOB })
  })

  test('a launch folder without stdin (cleaned up) is not open', async () => {
    const tree = launch(store(new Map(), [rec('pn-1')]), 'pn-1', 'cleaned')
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 0, storePath: GLOB })
  })

  test("another session's open review does not count", async () => {
    const tree = launch(launch(store(new Map(), [rec('pn-1', OTHER), rec('pn-2')]), 'pn-1', 'open'), 'pn-2', 'settled-delivered')
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 0, storePath: GLOB })
  })

  test('a missing store folder is count 0 with the path it looked at', async () => {
    expect(await openPlannotatorReviews(SID, STORE, fsOf(new Map()))).toEqual({ count: 0, storePath: GLOB })
  })

  test('a store folder with no plannotator file is count 0', async () => {
    const tree: Tree = new Map([[`${STORE}/track_inline-a.json`, '{}']])
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 0, storePath: GLOB })
  })

  test('two store files are read as a union', async () => {
    const tree = store(store(new Map(), [rec('pn-1')], 'plannotator_a.json'), [rec('pn-2'), rec('pn-3')], 'plannotator_b.json')
    for (const id of ['pn-1', 'pn-2']) launch(tree, id, 'open')
    launch(tree, 'pn-3', 'settled-delivered')
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 2, storePath: GLOB })
  })

  test('the same launch id in two files counts once', async () => {
    const tree = launch(store(store(new Map(), [rec('pn-1')], 'plannotator_a.json'), [rec('pn-1')], 'plannotator_b.json'), 'pn-1', 'open')
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ count: 1, storePath: GLOB })
  })
})

describe('openPlannotatorReviews: unknown, never throws', () => {
  test('a store file with no launches array is unknown', async () => {
    const tree: Tree = new Map([[`${STORE}/plannotator_a.json`, JSON.stringify({ approvals: [] })]])
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ unknown: true, errorClass: 'no-launches-array', storePath: GLOB })
  })

  test('a malformed store file is unknown with the parse error class', async () => {
    const tree: Tree = new Map([[`${STORE}/plannotator_a.json`, '{"launches": [ {"bridgeToken": "SECRET"']])
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ unknown: true, errorClass: 'SyntaxError', storePath: GLOB })
  })

  test('a throwing fs read resolves unknown (never rejects), names only the error class, and retries once', async () => {
    const tree = launch(store(new Map(), [rec('pn-1')]), 'pn-1', 'open')
    const calls: string[] = []
    const answer = await openPlannotatorReviews(SID, STORE, fsOf(tree, { calls, throwOn: op => op === 'read' }))
    expect(answer).toEqual({ unknown: true, errorClass: 'EIO', storePath: GLOB })
    expect(JSON.stringify(answer)).not.toContain('SECRET')
    expect(calls.filter(c => c.startsWith('read '))).toHaveLength(2)
  })

  test('a throwing stat of a launch folder is unknown', async () => {
    const tree = launch(store(new Map(), [rec('pn-1')]), 'pn-1', 'open')
    const answer = await openPlannotatorReviews(SID, STORE, fsOf(tree, { throwOn: (op, path) => op === 'exists' && path.startsWith(fixturePath('launch/')) }))
    expect(answer).toEqual({ unknown: true, errorClass: 'EIO', storePath: GLOB })
  })

  test('a failure on the first attempt only is answered by the retry', async () => {
    const tree = launch(store(new Map(), [rec('pn-1')]), 'pn-1', 'open')
    let reads = 0
    const answer = await openPlannotatorReviews(SID, STORE, fsOf(tree, { throwOn: op => op === 'read' && ++reads === 1 }))
    expect(answer).toEqual({ count: 1, storePath: GLOB })
  })

  test('a record of this session whose dir is not a string is unknown', async () => {
    const tree: Tree = new Map([[`${STORE}/plannotator_a.json`, JSON.stringify({ launches: [{ id: 'pn-1', sessionId: SID, dir: 7 }] })]])
    expect(await openPlannotatorReviews(SID, STORE, fsOf(tree))).toEqual({ unknown: true, errorClass: 'bad-launch-record', storePath: GLOB })
  })
})

describe('resolveReviewStoreDir', () => {
  test('defaults to ~/.claude/plugins/store and takes the override env', () => {
    expect(resolveReviewStoreDir(fixturePath('home/u'), undefined)).toBe(fixturePath('home/u/.claude/plugins/store'))
    expect(resolveReviewStoreDir(fixturePath('home/u'), '')).toBe(fixturePath('home/u/.claude/plugins/store'))
    expect(resolveReviewStoreDir(fixturePath('home/u'), fixturePath('fixtures/store'))).toBe(fixturePath('fixtures/store'))
  })
})
