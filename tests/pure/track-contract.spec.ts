import { describe, expect, test } from 'bun:test'
import { checkpointOf, restorationOf } from '../../hooks/track-contract'

const source = '11111111-2222-4333-8444-555555555555'
const destination = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const receipt = { v: 1, ok: true, source_session: source, revision: 7, checksum: 'a'.repeat(64), counts: { questions: 2, answers: 1, steps: 3 } }
const answer = (value: unknown) => ({ result: JSON.stringify(value) })

describe('v1 Track receipt validation', () => {
  test('accepts JSON text and the MCP text block transport', () => {
    expect(checkpointOf(answer(receipt), source)).toEqual({ checkpoint: receipt })
    expect(checkpointOf({ result: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } }, source)).toEqual({ checkpoint: receipt })
  })
  test('rejects refusal, error, raw objects, mixed text and unsupported versions', () => {
    for (const result of [{ deny: 'policy refused' }, { isError: true, result: 'error' }, { result: receipt }, { result: { content: [{ type: 'text', text: '{}' }, { type: 'text', text: JSON.stringify(receipt) }] } }, answer({ ...receipt, v: 2 })]) {
      expect(checkpointOf(result, source)).toHaveProperty('failure')
    }
  })
  test('requires the exact source and bounded integer revision and counts', () => {
    for (const value of [{ ...receipt, source_session: destination }, { ...receipt, revision: 0 }, { ...receipt, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...receipt, counts: { ...receipt.counts, answers: 3 } }, { ...receipt, counts: { ...receipt.counts, steps: -1 } }, { ...receipt, checksum: 'bad' }]) {
      expect(checkpointOf(answer(value), source)).toHaveProperty('failure')
    }
  })
  test('failed receipts preserve the failure reason', () => {
    expect(checkpointOf(answer({ ...receipt, ok: false, reason: 'unsaved: quota' }), source)).toEqual({ failure: 'unsaved: quota' })
  })
  test('restoration requires the actual destination and applied checksum', () => {
    const restored = { ...receipt, destination_session: destination, applied_checksum: receipt.checksum }
    expect(restorationOf(answer(restored), receipt, destination)).toEqual({ restored })
    for (const value of [{ ...restored, destination_session: source }, { ...restored, applied_checksum: 'b'.repeat(64) }, { ...receipt, destination_session: destination }, { ...restored, counts: { ...receipt.counts, steps: 2 } }]) {
      expect(restorationOf(answer(value), receipt, destination)).toHaveProperty('failure')
    }
  })
})
