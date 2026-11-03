// FIXTURE: TRACK-23, 2026-10-14. Explicitly deferred work was rejected because
// pending coverage required waiting, even when the saved row was paused.
import { expect, test } from 'bun:test'
import { pendingCoverage, pendingItems, renderPendingItems } from '../../hooks/pending-items'
import type { TrackCheckpoint } from '../../hooks/track-contract'

const note = `${'Preserve the owner and blocker details. '.repeat(8)}Waiting for approval. 😀`
const item = { track_id: 'plan:5', subject: 'Deferred report rebuild', note, unblock: 'Approve the rebuild', status: 'paused' as const }
const snapshot = (record: unknown) => `## 3. Pending, owned by the user\n- Pending: ${JSON.stringify(record)}\n\n## 4. Work done\n- none`
const checkpoint = (changes = {}): TrackCheckpoint => ({
  v: 1, ok: true, source_session: '11111111-2222-4333-8444-555555555555',
  revision: 69, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: 1 },
  open_steps: [{ id: item.track_id, subject: item.subject, note, status: 'paused', ...changes }],
})

test('an explicitly paused pending record keeps its complete metadata through parse and render', () => {
  const parsed = pendingItems(snapshot(item))
  expect(parsed).toEqual({ items: [item] })
  if ('failure' in parsed) throw new Error(parsed.failure)
  expect(pendingItems(renderPendingItems(snapshot(item), parsed.items))).toEqual(parsed)
})

test('coverage accepts an explicitly paused row without converting its status or shortening its note', () => {
  const receipt = checkpoint()
  const before = JSON.stringify(receipt)
  expect(pendingCoverage([item], receipt)).toBeNull()
  expect(JSON.stringify(receipt)).toBe(before)
})

test('explicit waiting records retain waiting semantics', () => {
  const waiting = { ...item, status: 'waiting' as const }
  expect(pendingItems(snapshot(waiting))).toEqual({ items: [waiting] })
  expect(pendingCoverage([waiting], checkpoint({ status: 'waiting' }))).toBeNull()
  expect(pendingCoverage([waiting], checkpoint())).not.toBeNull()
})

test('old records without status continue to require a waiting row', () => {
  const { status: _status, ...legacy } = item
  expect(pendingItems(snapshot(legacy))).toEqual({ items: [legacy] })
  expect(pendingCoverage([legacy], checkpoint())).not.toBeNull()
  expect(pendingCoverage([legacy], checkpoint({ status: 'waiting' }))).toBeNull()
})

test('an explicit paused status does not forgive a changed row, note or title', () => {
  for (const changes of [
    { status: 'waiting' }, { status: 'completed' }, { id: 'plan:6' },
    { subject: 'Different work' }, { note: note.slice(0, 200) },
  ]) expect(pendingCoverage([item], checkpoint(changes))).not.toBeNull()
})

test('unknown fields and unsupported statuses cannot become pending records', () => {
  for (const record of [
    { ...item, status: 'completed' }, { ...item, status: 'in_progress' },
    { ...item, status: null }, { ...item, approval: true },
  ]) expect(pendingItems(snapshot(record))).toHaveProperty('failure')
})
