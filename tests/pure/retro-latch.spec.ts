import { fixturePath } from '../fixtures/paths'

import { describe, expect, test } from 'bun:test'

import { TIMEOUTS_MS } from '../../hooks/config'
import { classifyRetroCarry, needsRetroCarry, RETRO_CARRY_TIMEOUT_MS, retroCarryArgv, retroGatePath, retroPaths } from '../../hooks/retro-latch'

const OLD = '11111111-aaaa-4bbb-8ccc-000000000001'
const NEW = '22222222-aaaa-4bbb-8ccc-000000000002'
const HOME = fixturePath('Users/someone')

describe('TRACK-23 retro latch carry', () => {
  test('only an active, unapproved latch is carried', () => {
    expect(needsRetroCarry({ active: true, approved: false })).toBe(true)
    expect(needsRetroCarry({ active: true, approved: true })).toBe(false)
    expect(needsRetroCarry({ active: false, approved: false })).toBe(false)
    expect(needsRetroCarry(null)).toBe(false)
    expect(needsRetroCarry(undefined)).toBe(false)
  })

  test('latch paths are the gate paths, keyed by a safe session id', () => {
    expect(retroPaths(HOME, OLD)).toEqual({
      active: `${HOME}/.claude/state/retro/active-${OLD}`,
      approved: `${HOME}/.claude/state/retro/approved-${OLD}`,
    })
    expect(retroPaths(HOME, '../x')).toBeNull()
  })

  test('the carry pins the gate state folder, names no approval file and ends inside the carry deadline', () => {
    const argv = retroCarryArgv(HOME, OLD, NEW)
    expect(argv).toEqual(['env', `RETRO_STATE_DIR=${HOME}/.claude/state/retro`, 'bash', `${HOME}/.claude/skills/retro/scripts/retro-gate.sh`, 'carry', OLD, NEW])
    expect(retroGatePath(HOME)).toBe(`${HOME}/.claude/skills/retro/scripts/retro-gate.sh`)
    expect((argv ?? []).some(a => a.includes('approved'))).toBe(false)
    expect(RETRO_CARRY_TIMEOUT_MS).toBeLessThan(TIMEOUTS_MS.carry)
  })

  test('unsafe or identical ids build no command', () => {
    expect(retroCarryArgv(HOME, OLD, OLD)).toBeNull()
    expect(retroCarryArgv(HOME, OLD, 'a/b')).toBeNull()
    expect(retroCarryArgv(HOME, 'short', NEW)).toBeNull()
  })

  test('exit codes: 0 carried, 5 skipped, 6 skipped only when the source latch is gone, anything else fails', () => {
    expect(classifyRetroCarry(0, '', false)).toEqual({ carried: true })
    expect(classifyRetroCarry(5, '', false)).toEqual({ skipped: 'approved since the brief was queued' })
    expect(classifyRetroCarry(6, '', false)).toEqual({ skipped: 'latch released since the brief was queued' })
    expect(classifyRetroCarry(6, '', true)).toEqual({ failure: 'retro-gate.sh carry exit 6, but the source latch is still active' })
    expect(classifyRetroCarry(7, 'CARRY-REFUSED\n', false)).toEqual({ failure: 'retro-gate.sh carry exit 7: CARRY-REFUSED' })
    expect(classifyRetroCarry(-1, '', false)).toEqual({ failure: 'retro-gate.sh carry exit -1: ' })
  })
})
