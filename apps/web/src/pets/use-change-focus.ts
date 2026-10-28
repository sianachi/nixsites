import { useEffect, useRef, type RefObject } from 'react';

/** Moves focus into the panel when "Change" opens it, and back to "Change" when it closes. */
export function useChangeFocus(editing: boolean): {
  readonly panel: RefObject<HTMLElement | null>;
  readonly change: RefObject<HTMLButtonElement | null>;
} {
  const panel = useRef<HTMLElement>(null);
  const change = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (editing) {
      moved.current = true;
      panel.current?.focus();
    } else if (moved.current) change.current?.focus();
  }, [editing]);
  return { panel, change };
}
