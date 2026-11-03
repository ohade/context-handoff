import { protocolPath } from '../fixtures/paths'

import { describe, expect, test } from 'bun:test'

import { carryWrites, decideCarry, markerPaths } from '../../hooks/markers'

const NEW = '22222222-aaaa-4bbb-8ccc-000000000002'

describe('marker carry', () => {
  test('carries when both markers name the same project (whitespace ignored as the reader does)', () => {
    expect(decideCarry({ project: 'sample-project\n', verified: 'sample-project\n' })).toEqual({ project: 'sample-project' })
  })

  test('different projects are not carried', () => {
    expect(decideCarry({ project: 'sample-project', verified: 'other-project' })).toEqual({ skip: 'markers name different projects (sample-project vs other-project)' })
  })

  test('a missing marker or snapshot is not carried', () => {
    expect(decideCarry(null)).toEqual({ skip: 'no marker snapshot' })
    expect(decideCarry({ project: null, verified: 'sample-project' })).toEqual({ skip: 'no project marker before the clear' })
    expect(decideCarry({ project: 'sample-project', verified: null })).toEqual({ skip: 'no verified marker before the clear' })
    expect(decideCarry({ project: '  ', verified: '' })).toEqual({ skip: 'project marker is empty' })
  })

  test('a name the marker validator would refuse is not carried', () => {
    expect(decideCarry({ project: 'a/b', verified: 'a/b' })).toEqual({ skip: 'project name fails the marker name rule' })
  })

  test('writes exactly the project and verified markers of the new id, nothing else', () => {
    expect(carryWrites(NEW, 'sample-project')).toEqual([
      { path: protocolPath(`claude-project-${NEW}`), text: 'sample-project\n' },
      { path: protocolPath(`claude-project-verified-${NEW}`), text: 'sample-project\n' },
    ])
    const paths = (carryWrites(NEW, 'sample-project') ?? []).map(w => w.path).join(' ')
    expect((carryWrites(NEW, 'sample-project') ?? []).map(w => w.path.split('/').slice(1, -1))).toEqual([['tmp'], ['tmp']])
    expect(paths).not.toContain('start')
    expect(paths).not.toContain('update')
  })

  test('an unsafe session id gets no paths', () => {
    expect(markerPaths('../etc')).toBeNull()
    expect(carryWrites('a/b', 'x')).toBeNull()
  })
})
