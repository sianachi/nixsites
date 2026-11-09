import { Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

/**
 * The small "Saved" confirmation beside a field that saves as it changes. `show()` flashes it for
 * two seconds; `mark` goes next to the field. Decorative: the undo bar says the same in words.
 */
export function useSavedMark(): { readonly mark: ReactElement; readonly show: () => void } {
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    if (visible === 0) return undefined;
    const timer = setTimeout(() => {
      setVisible(0);
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [visible]);
  return {
    show: () => {
      setVisible((n) => n + 1);
    },
    mark: (
      // Text forwards no extra props, so the marker and aria-hidden sit on a wrapper.
      <span
        aria-hidden="true"
        data-saved-mark={visible === 0 ? 'off' : 'on'}
        className={visible === 0 ? 'invisible' : ''}
      >
        <Text as="span" variant="caption" tone="muted">
          ✓ Saved
        </Text>
      </span>
    ),
  };
}

/** Who a section's changes reach, said once under its title. */
export function ScopeNote(props: { readonly children: string }): ReactElement {
  return (
    <Text as="p" variant="caption" tone="muted" data-scope="">
      {props.children}
    </Text>
  );
}
