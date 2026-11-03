// One error text for log lines and machine events: the error class, then its message. Pure.

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
