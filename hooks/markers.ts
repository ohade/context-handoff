// The two project markers a handoff carries to the new session id. Pure.
// Only these two files are ever carried: never the start, update or
// Stop-gate markers (a copy would arm the Stop gates in the new session).

import type { MarkerSnapshot } from './machine-types'

/** The marker validator's own name rule (hooks/lib/validate-project-marker.py SAFE). */
const SAFE_NAME = /^[A-Za-z0-9._:-]{1,96}$/
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export type MarkerPaths = { project: string; verified: string }

export function markerPaths(sessionId: string): MarkerPaths | null {
  if (!SAFE_SESSION.test(sessionId)) return null
  return { project: `/tmp/claude-project-${sessionId}`, verified: `/tmp/claude-project-verified-${sessionId}` }
}

/** Carry only when both markers existed before the clear and name the same project. */
export function decideCarry(snapshot: MarkerSnapshot | null): { project: string } | { skip: string } {
  if (snapshot === null) return { skip: 'no marker snapshot' }
  if (snapshot.project === null) return { skip: 'no project marker before the clear' }
  if (snapshot.verified === null) return { skip: 'no verified marker before the clear' }
  const project = snapshot.project.replace(/\s/g, '')
  const verified = snapshot.verified.trim()
  if (project === '') return { skip: 'project marker is empty' }
  if (!SAFE_NAME.test(project)) return { skip: 'project name fails the marker name rule' }
  if (project !== verified) return { skip: `markers name different projects (${project} vs ${verified})` }
  return { project }
}

/** The exact writes for the new session id. */
export function carryWrites(toSessionId: string, project: string): Array<{ path: string; text: string }> | null {
  const paths = markerPaths(toSessionId)
  if (paths === null) return null
  return [
    { path: paths.project, text: `${project}\n` },
    { path: paths.verified, text: `${project}\n` },
  ]
}
