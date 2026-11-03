// The per-process owner stamp: `<claude pid>:<uuid>`. Pure.
// CONTEXT_HANDOFF_OWNER is inherited by child processes ($.env.set reaches
// everything the process starts), so an inherited value is adopted only when
// its pid is this process; the d.ts offers no pid, so register reads the
// parent pid of a `sh -c 'echo $PPID'` child.

const OWNER_RE = /^(\d+):(.+)$/

export function parsePid(stdout: string): number | null {
  const text = stdout.trim()
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null
}

export function resolveOwner(inherited: string | undefined, pid: number | null, freshUuid: string): { ownerId: string; isAdopted: boolean } {
  const match = inherited === undefined ? null : OWNER_RE.exec(inherited)
  if (pid !== null && match && Number(match[1]) === pid) return { ownerId: inherited as string, isAdopted: true }
  return { ownerId: `${pid ?? 0}:${freshUuid}`, isAdopted: false }
}
