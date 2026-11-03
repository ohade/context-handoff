// handoff.log lines (C5): one line per event, ISO time first. Pure.
// Each line is appended by its own O_APPEND write (a `sh` redirect), so
// concurrent sessions and an old and new module around a reload never
// rewrite each other's lines. The line and path are arguments, never script text.

const MAX_LINE = 4_000
const ROTATE_BYTES = 5_000_000

export function formatLogLine(iso: string, sessionId: string, event: string, detail: string): string {
  const line = `${iso} ${sessionId.slice(0, 8)} ${event} ${detail.replace(/\s+/g, ' ').trim()}`
  return line.length <= MAX_LINE ? line : `${line.slice(0, MAX_LINE - 3)}...`
}

/**
 * argv for `$.process.run`: create the folder, rotate past 5 MB to `.1`, append one line. Only the
 * writer that creates the `.lock` folder (atomic `mkdir`) rotates, after re-checking the size; the
 * append runs whatever the rotation did, so a failed or skipped rotation never drops the line. A lock
 * older than 5 minutes is treated as stale (its writer was killed) and cleared. The log holds the
 * first 60 characters of typed prompts, so everything is created under umask 077 and the log and its
 * rotated copy are set to 0600 after each append (an older, looser file is tightened).
 */
export function appendArgv(path: string, line: string): string[] {
  const script =
    'umask 077; mkdir -p "$(dirname "$2")" || exit 1; ' +
    // A lock older than 5 minutes was left by a killed writer: clear it so rotation is not disabled for good.
    'if [ -d "$2.lock" ] && [ -n "$(find "$2.lock" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then rmdir "$2.lock" 2>/dev/null; fi; ' +
    `if [ -f "$2" ] && [ "$(wc -c < "$2")" -gt ${ROTATE_BYTES} ] && mkdir "$2.lock" 2>/dev/null; then ` +
    // Re-check under the lock: another writer may have rotated between our check and our mkdir.
    `if [ "$(wc -c < "$2")" -gt ${ROTATE_BYTES} ]; then mv -f "$2" "$2.1" 2>/dev/null; fi; rmdir "$2.lock"; fi; ` +
    // The line is in once printf succeeds: a chmod that fails (a missing .1) does not fail the append.
    'printf \'%s\\n\' "$1" >> "$2" || exit 1; chmod 600 "$2" "$2.1" 2>/dev/null; exit 0'
  return ['sh', '-c', script, 'sh', line, path]
}
