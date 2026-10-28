/** Whether the primary pointer is coarse - touch or a stylus, rather than a mouse. */
export function isPointerCoarse(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}
