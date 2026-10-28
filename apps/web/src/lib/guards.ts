/** Read through a function so TypeScript does not narrow the flag to a stale literal across an `await`. */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
