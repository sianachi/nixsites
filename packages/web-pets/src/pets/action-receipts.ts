// Opaque message IDs and outcomes only; never document text or credentials.
export function readActionReceipt(id: string): string {
  try {
    return sessionStorage.getItem(`nix.pet.action.${id}`) ?? '';
  } catch {
    return '';
  }
}

export function writeActionReceipt(id: string, outcome: string): void {
  try {
    sessionStorage.setItem(`nix.pet.action.${id}`, outcome);
  } catch {
    /* The open panel still retains its receipt. */
  }
}
