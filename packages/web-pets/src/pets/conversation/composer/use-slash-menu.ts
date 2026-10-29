import { useListbox } from '@nix/ui';
import { useState } from 'react';

/** Typing `/` at the start of the composer offers the same actions as the empty state's
 * buttons, filtered by what follows the slash. Escape or leaving the field hides it until the
 * draft stops being a slash command. */
export function useSlashMenu(
  draft: string,
  suggestions: readonly string[],
  onPick: (suggestion: string) => void,
): {
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly listbox: ReturnType<typeof useListbox>;
  readonly dismiss: () => void;
} {
  const [dismissed, setDismissed] = useState(false);
  const query = /^\/(\S*)$/.exec(draft)?.[1]?.toLowerCase();
  if (query === undefined && dismissed) setDismissed(false);
  const options =
    query === undefined || dismissed
      ? []
      : suggestions
          .filter((suggestion) => suggestion.toLowerCase().includes(query))
          .map((suggestion) => ({ id: suggestion, label: suggestion }));
  const listbox = useListbox(options, (option) => {
    onPick(option.id);
  });
  return {
    options,
    listbox,
    dismiss: () => {
      setDismissed(true);
    },
  };
}
