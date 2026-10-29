/** The header's status line, in plain words rather than the raw animation state - never
 * "listening" or "hover", only what the person actually needs to know right now. `needsDecision`
 * - whether *this* turn's tools were reported back by `PetWorkTools` as actually waiting on the
 * owner (11/12/S1) - is the only source for "Waiting for your approval": an auto-run read that
 * happens to still be `pending` must never say so. */
/** States the header shows only to assistive technology: the in-log "is thinking" row and the
 * streaming draft already show them. */
export function statusIsQuiet(status: string): boolean {
  return status === 'Ready' || status === 'Thinking' || status === 'Writing';
}

export function statusText({
  runtimeLoaded,
  connected,
  errored,
  hasDraft,
  needsDecision,
  running,
}: {
  readonly runtimeLoaded: boolean;
  readonly connected: boolean;
  readonly errored: boolean;
  readonly hasDraft: boolean;
  readonly needsDecision: boolean;
  readonly running: boolean;
}): string {
  if (!runtimeLoaded) return 'Connecting';
  if (!connected) return 'Not connected';
  if (errored) return 'Something went wrong';
  if (hasDraft) return 'Writing';
  if (needsDecision) return 'Waiting for your approval';
  if (running) return 'Thinking';
  return 'Ready';
}
