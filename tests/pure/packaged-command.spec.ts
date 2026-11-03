import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { extractorArgv, isHandoffRequest } from '../../hooks/handoff-now'
import { isOwnRunMarkup } from '../../hooks/machine'
import { autoRunCycleOf } from '../../hooks/turns'

const session = randomUUID()
const cycle = `${session}#1`
const args = `automatic-run cycle=${cycle} session=${session}`
const markup = (command: string, argumentsText = args) =>
  `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${argumentsText}</command-args>`

test('the packaged manual command opens the same door as the legacy command', () => {
  expect(isHandoffRequest('/context-handoff:compact-crafter')).toBe(true)
  expect(isHandoffRequest('/compact-crafter')).toBe(true)
  expect(isHandoffRequest('/unrelated:compact-crafter')).toBe(false)
  expect(isHandoffRequest('Do not run /context-handoff:compact-crafter')).toBe(false)
  expect(isHandoffRequest('What does /context-handoff:compact-crafter do?')).toBe(false)
})

test('only the packaged automatic command names the armed run', () => {
  expect(autoRunCycleOf(`/context-handoff:compact-crafter ${args}`)).toBe(cycle)
  expect(autoRunCycleOf(`/unrelated:compact-crafter ${args}`)).toBeNull()
  expect(autoRunCycleOf(`/compact-crafter ${args}`)).toBeNull()
  expect(isOwnRunMarkup(markup('context-handoff:compact-crafter'), cycle, session)).toBe(true)
  expect(isOwnRunMarkup(markup('unrelated:compact-crafter'), cycle, session)).toBe(false)
  expect(isOwnRunMarkup(markup('compact-crafter'), cycle, session)).toBe(false)
  expect(isOwnRunMarkup(markup('context-handoff:compact-crafter', `automatic-run cycle=${session}#2 session=${session}`), cycle, session)).toBe(false)
  expect(isOwnRunMarkup(markup('context-handoff:compact-crafter'), cycle, randomUUID())).toBe(false)
})

test('manual extraction excludes both command spellings from the continuation objective', () => {
  const command = extractorArgv(join(tmpdir(), 'synthetic-extractor.py'), join(tmpdir(), `${session}.jsonl`), '/context-handoff:compact-crafter')
  const excluded = command.flatMap((value, index) => value === '--exclude-prefix' ? [command[index + 1]] : [])
  expect(excluded).toContain('/context-handoff:compact-crafter')
  expect(excluded).toContain('/compact-crafter')
})
