/**
 * Whether the person has asked their system for less motion.
 *
 * Read at the moment it is needed rather than cached, because the setting can change while the
 * application is open. Where `matchMedia` does not exist the answer is "no preference", which is
 * what its absence means.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
