import { Button, Text, focusRing } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { noteColumn } from '@nix/web-foundation/layout/regions';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import type { ShellContext } from '../../shell/shell-context';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';

interface ItemHeaderProps {
  readonly reading: boolean;
  readonly trailing: ReactNode;
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;
  readonly bodyKind: string;
  readonly onNavigate: (itemId: string) => void;

  /** Editing the title is a commitment to this document. */
  readonly onCommit: () => void;
}

export function ItemHeader({
  tree,
  itemId,
  title,
  bodyKind,
  onNavigate,
  onCommit,
  reading,
  trailing,
}: ItemHeaderProps): ReactNode {
  const narrow = useNarrowViewport();
  const zen = useZenActive();
  const trail = tree.breadcrumbs(itemId);
  const parent = trail.at(-2);
  // Keyed on the item by its caller, so the draft is rebuilt rather than carried. A title held in
  // state and not reset is the classic mirrored-prop bug: navigating from one note to another would
  // leave the previous note's name in the field, and the next blur would save it onto the new one.
  const [draft, setDraft] = useState(title);
  const titleRef = useRef<HTMLInputElement>(null);

  // A freshly created item arrives called "Untitled note" and the next thing anybody does is name
  // it. Selecting the placeholder means that is one keystroke rather than a click, a select-all and
  // a keystroke - and because the text is selected rather than cleared, somebody who came here to
  // read instead of rename loses nothing by clicking away.
  useEffect(() => {
    if (title.startsWith('Untitled')) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [itemId, title]);

  return (
    <header className={`min-w-0 flex-1 px-3 py-2 sm:px-5 sm:py-3 ${zen ? 'pr-16 sm:pr-16' : ''}`}>
      <div className={reading ? noteColumn : undefined}>
        {narrow && !zen ? (
          <div className="flex items-center gap-2">
            {/* No Back button: browser history here can lead back out to the sign-in redirect.
              Going up is the parent's own button, which always stays inside the workspace. */}
            {parent ? (
              <Button
                variant="ghost"
                className="min-w-0"
                onClick={() => {
                  onNavigate(parent.id);
                }}
              >
                <Text as="span" variant="caption" className="truncate">
                  {parent.title || 'Untitled'}
                </Text>
              </Button>
            ) : null}
          </div>
        ) : null}
        {!narrow && !zen && trail.length > 1 ? (
          <nav
            aria-label="Breadcrumb"
            className="mb-1 hidden flex-wrap items-center text-xs sm:flex"
          >
            {trail.slice(0, -1).map((ancestor) => (
              <span key={ancestor.id} className="flex items-center">
                {/* Navigable, not decorative. A trail that shows where you are and cannot take you
                  there is a label pretending to be a control, and everybody tries to click it. */}
                <button
                  type="button"
                  onClick={() => {
                    onNavigate(ancestor.id);
                  }}
                  className={`text-muted underline-offset-2 hover:text-foreground hover:underline ${focusRing}`}
                >
                  {ancestor.title || 'Untitled'}
                </button>
                <span aria-hidden="true" className="px-1 text-muted">
                  /
                </span>
              </span>
            ))}
          </nav>
        ) : null}

        <div className="flex items-center gap-2">
          <input
            ref={titleRef}
            aria-label={`${bodyKind === 'canvas' ? 'Canvas' : bodyKind === 'spreadsheet' ? 'Spreadsheet' : 'Note'} title`}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              onCommit();
            }}
            onBlur={() => {
              // On blur rather than on every keystroke: a rename is a write to the item row, and one
              // per character would be a request per character.
              if (draft !== title) {
                void tree.rename(itemId, draft);
              }
            }}
            // No `outline-none` beside the ring. In Tailwind v4 that utility sets `--tw-outline-style:
            // none` on the element, and `focus-visible:outline-2` resolves its style through the same
            // variable - so the two together left the field that renames an item with no visible focus
            // at all. `focusRing` replaces the UA outline rather than removing it, which is the whole
            // point of the primitive.
            className={`min-h-(--control-sm) min-w-0 flex-1 bg-transparent font-heading text-lg font-semibold leading-snug sm:text-xl ${focusRing}`}
          />
          {trailing}
        </div>
      </div>
    </header>
  );
}
