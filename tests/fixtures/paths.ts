// Native engine fixtures permit only relative imports. These generated path strings live in
// the in-memory world; real-file specs allocate their own temporary directories.
import { markerPaths } from '../../hooks/markers'

const root = `/context-handoff-fixtures-${crypto.randomUUID()}`
const projectMarker = markerPaths('fixture-session')?.project
if (projectMarker === undefined) throw new Error('the project-marker fixture session must be valid')
const protocolRoot = projectMarker.slice(0, projectMarker.lastIndexOf('/'))

/** Keep traversal segments and shell characters intact so refusal cases test the original input. */
export function fixturePath(relative: string): string {
  return `${root}/${relative}`
}

/** The optional project-marker protocol uses the POSIX tmp namespace, inside the fake world. */
export function protocolPath(name: string): string {
  return `${protocolRoot}/${name}`
}
