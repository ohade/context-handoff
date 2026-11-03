import { fixturePath } from '../fixtures/paths'

// FIXTURE: TRACK-23, 2026-10-15. The final visible response must survive handoff.
import { expect, test } from 'bun:test'
import { initialState, step } from '../../hooks/machine'
import type { MachineState } from '../../hooks/machine'
import { resolveConfig } from '../../hooks/config'
import { parseState, serializeState } from '../../hooks/state-file'

const config = resolveConfig({}, {}).config
const source = '11111111-aaaa-4bbb-8ccc-000000000001'
const destination = '22222222-aaaa-4bbb-8ccc-000000000002'
const answer = `Keep this **exactly**.\n\n${'A long answer. '.repeat(200)}\nסוף\n`
const response = { sessionId: source, turnId: 'work', text: answer }

function finish(state: MachineState, extra = {}) {
  return step(state, {
    type: 'turnEnd', sessionId: source, turnId: 'work', now: 10,
    reason: 'answer', answer, tokens: 10_000, draft: '',
    isKillSwitchOn: false, openReviews: 0, ...extra,
  }, config).state as MachineState & { lastResponse?: unknown; responseReplay?: unknown }
}

test('the full final visible response is saved even below the handoff threshold', () => {
  const state = finish(initialState(source, 0, 'owner'))
  expect(state.lastResponse).toEqual(response)
  expect((parseState(serializeState(state)) as any)?.lastResponse).toEqual(response)
})

test('handoff helper output, a child answer and an interrupted turn preserve the prior response', () => {
  const state = { ...initialState(source, 0, 'owner'), lastResponse: response }
  for (const extra of [
    { isHandoffTurn: true }, { agentId: 'child' }, { reason: 'aborted' }, { answer: '' },
  ]) {
    expect(finish(state, { answer: 'Not the completed user response', ...extra }).lastResponse).toEqual(response)
  }
})

test('the old response is prepared for exactly the detected destination', () => {
  const state = {
    ...initialState(source, 0, 'owner'), lastResponse: response,
    phase: 'CLEARING' as const, cycleId: `${source}#1`, deadline: 10_000,
    clearingFrom: source, briefPath: fixturePath('brief.md'),
  }
  const carried = step(state, { type: 'newIdResolved', cycleId: `${source}#1`, now: 100, sessionId: destination }, config).state as any
  expect(carried.responseReplay).toEqual({
    cycleId: `${source}#1`, destinationSession: destination, response, status: 'pending', uuid: null,
  })
  expect((parseState(serializeState(carried)) as any)?.responseReplay).toEqual(carried.responseReplay)
})

test('an unrelated session switch cannot inherit a response from the previous session', () => {
  const state = { ...initialState(source, 0, 'owner'), lastResponse: response }
  const moved = step(state, { type: 'sessionStart', now: 100, sessionId: destination, source: 'resume' }, config).state as any
  expect(moved.lastResponse).toBeNull()
  expect(moved.responseReplay).toBeNull()
})

test('malformed persisted response fields are not rendered as valid saved text', () => {
  const raw = { ...initialState(source, 0, 'owner'), lastResponse: { ...response, text: 42 }, responseReplay: { status: 'pending' } }
  const state = parseState(JSON.stringify(raw)) as any
  expect(state.lastResponse).toBeNull()
  expect(state.responseReplay).toBeNull()
})
