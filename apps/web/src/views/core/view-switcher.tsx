import { Icon, Select, focusRing } from '@nix/ui';
import { FileText, List as ListIcon, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { DOCUMENT_VIEW, type View } from '@nix/web-collections/core/container-model';
import { findViewKind } from './view-kinds';

/**
 * The per-container view switcher.
 *
 * **Scoped to a container, and that is the whole point.** The application used to carry a
 * top-level tab strip with "Board" on it, which said that a board was a place you go. It is not:
 * it is a way of looking at one folder, and the same folder can be a list a moment later. So the
 * switcher lives above the container's contents and moves with you.
 *
 * A view that cannot currently render is still offered, marked, and explains itself when selected.
 * Hiding it would be worse: somebody who configured a board and then deleted the property it
 * groups by needs to find that board in order to fix it, and a switcher that quietly dropped it
 * would leave them with no way back to their own configuration.
 *
 * **The document is the first entry, and it is not one of the views.** An item's body and its
 * views answer different questions - the body is the item's own content, a view renders its
 * children - but only one of them is on screen at a time, so one control chooses between them.
 * That is why the document is passed as a flag rather than smuggled in as a fourth view kind: it
 * has no configuration, cannot be reordered or deleted, and is the one entry every item has.
 */

/**
 * Where a tool's second line (an open phone search field) is drawn: a slot after the item controls,
 * so DOM and focus order match the visual order. Null outside a switcher row.
 */
export const BelowRowSlot = createContext<HTMLElement | null>(null);

export interface ViewSwitcherProps {
  readonly views: readonly View[];
  readonly unrenderable: readonly string[];
  readonly activeViewId: string | null;
  readonly onSelect: (viewId: string) => void;

  /** What to call the item's own body. Omit to leave the document out entirely. */
  readonly documentLabel?: string;

  /**
   * Whether the item has chosen to leave its document tab out. The body is still there; only the
   * way to it from this row is gone, so the entry is dropped rather than disabled.
   */
  readonly documentHidden?: boolean;

  /**
   * Which entry the item opens as when nobody has asked for another. Marked quietly, so the choice
   * made in the settings panel is visible where people actually look.
   */
  readonly defaultViewId?: string;

  /**
   * Controls about the item itself rather than its views - on a phone, its details and actions -
   * held at the end of the row and kept in place while the tabs scroll.
   */
  readonly trailing?: ReactNode;

  /**
   * Search and view options, held in the same row as the switcher: after the tabs on a wide
   * screen, between the picker and the item controls on a phone.
   */
  readonly tools?: ReactNode;
}

export function ViewSwitcher(props: ViewSwitcherProps): ReactNode {
  const {
    views,
    unrenderable,
    activeViewId,
    onSelect,
    documentLabel,
    documentHidden,
    defaultViewId,
    trailing,
    tools,
  } = props;

  // Nothing to choose between. An item nobody has configured a view on shows its body and no
  // chrome at all, which is every plain note - a lone "Document" tab would be a control with one
  // option, taking up a row to say what the screen already shows.
  if (views.length === 0) {
    return null;
  }

  return (
    <ViewStrip
      views={views}
      unrenderable={unrenderable}
      activeViewId={activeViewId}
      onSelect={onSelect}
      {...(documentLabel === undefined ? {} : { documentLabel })}
      {...(documentHidden === undefined ? {} : { documentHidden })}
      {...(defaultViewId === undefined ? {} : { defaultViewId })}
      {...(trailing === undefined ? {} : { trailing })}
      {...(tools === undefined ? {} : { tools })}
    />
  );
}

function ViewStrip(props: ViewSwitcherProps): ReactNode {
  const { trailing, tools } = props;
  const narrow = useNarrowViewport();
  const [below, setBelow] = useState<HTMLElement | null>(null);
  const strip = narrow ? <ViewSelect {...props} /> : <ViewTabs {...props} />;
  if (trailing === undefined && tools === undefined) return strip;
  // Wraps so a tool's second line (an open phone search field) can drop below the row. The strip
  // gives up width first: tabs scroll and the picker shrinks, the tools and item controls do not.
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 pr-3 sm:pr-8">
      <div className="min-w-0 flex-1">{strip}</div>
      <BelowRowSlot value={below}>{tools}</BelowRowSlot>
      {trailing === undefined ? null : (
        <div className="flex shrink-0 items-center gap-1">{trailing}</div>
      )}
      <div ref={setBelow} className="basis-full empty:hidden" />
    </div>
  );
}

/** The phone's picker: one native select, so six long view names never push into the item controls. */
function ViewSelect(props: ViewSwitcherProps): ReactNode {
  const {
    views,
    unrenderable,
    activeViewId,
    onSelect,
    documentLabel,
    documentHidden,
    defaultViewId,
  } = props;
  const mark = (name: string, id: string): string =>
    `${name}${id === defaultViewId ? ' (default)' : ''}${unrenderable.includes(id) ? ' (needs attention)' : ''}`;
  return (
    <div className="min-w-0 px-4 py-1.5">
      <Select
        aria-label="View"
        value={activeViewId ?? ''}
        onChange={(event) => {
          onSelect(event.target.value);
        }}
      >
        {activeViewId === '' || activeViewId === null ? <option value="" hidden disabled /> : null}
        {documentLabel === undefined || documentHidden === true ? null : (
          <option value={DOCUMENT_VIEW}>{mark(documentLabel, DOCUMENT_VIEW)}</option>
        )}
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {mark(view.name, view.id)}
          </option>
        ))}
      </Select>
    </div>
  );
}

function ViewTabs(props: ViewSwitcherProps): ReactNode {
  const {
    views,
    unrenderable,
    activeViewId,
    onSelect,
    documentLabel,
    documentHidden,
    defaultViewId,
  } = props;
  const stripRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const strip = stripRef.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    // `nearest` so a tab already on screen does not move. jsdom has no `scrollIntoView`; the test
    // setup supplies one.
    current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeViewId]);

  return (
    // px-8, not px-4: this nav's own box sits in the same left-reading edge as the item header
    // above it (`ItemHeader`, `px-8 pb-3 pt-4`) and the document body below it (`NoteEditor`,
    // `px-8 py-6`) - the first tab's border, not its label, is what lines up at that edge, the
    // label sitting a further px-2 in from the tab's own padding. At px-4 the row sat 13.6px inside
    // where the title and the prose both start, which is exactly the "gap between a view's chrome
    // and its content" the owner report named. True of the header and the document body only: a
    // view's own content (board, gallery, list, calendar, timeline) carries no horizontal padding
    // of its own at all, and this correction widens rather than closes that separate mismatch - see
    // the rhythm specimen's own note on the point (`rhythm-specimen.tsx`).
    //
    // **One row that scrolls, never one that wraps.** A container with six views on a phone used to
    // push the strip onto three lines above the content it switches between. The row now scrolls
    // sideways, snapping to tabs, and the current tab is brought into view when it changes - so a
    // view chosen at the far end is not selected somewhere off screen.
    <nav
      ref={stripRef}
      aria-label="Views"
      className="flex min-w-0 max-w-full snap-x items-center gap-1 overflow-x-auto px-4 py-1.5 sm:px-8"
    >
      {documentLabel === undefined || documentHidden === true ? null : (
        <SwitcherTab
          icon={FileText}
          label={documentLabel}
          active={activeViewId === DOCUMENT_VIEW}
          isDefault={defaultViewId === DOCUMENT_VIEW}
          broken={false}
          onSelect={() => {
            onSelect(DOCUMENT_VIEW);
          }}
        />
      )}

      {views.map((view) => {
        const active = view.id === activeViewId;
        const broken = unrenderable.includes(view.id);
        // A kind this build does not know still gets a tab - the view exists and hiding it would
        // make it unreachable - but it borrows the list icon, since there is no glyph for it.
        const icon = findViewKind(view.kind)?.icon ?? ListIcon;

        return (
          <SwitcherTab
            key={view.id}
            icon={icon}
            label={view.name}
            active={active}
            isDefault={view.id === defaultViewId}
            broken={broken}
            onSelect={() => {
              onSelect(view.id);
            }}
          />
        );
      })}
    </nav>
  );
}

interface SwitcherTabProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active: boolean;
  readonly isDefault: boolean;
  readonly broken: boolean;
  readonly onSelect: () => void;
}

function SwitcherTab({
  icon,
  label,
  active,
  isDefault,
  broken,
  onSelect,
}: SwitcherTabProps): ReactNode {
  const descriptionId = useId();
  return (
    <button
      type="button"
      // aria-current rather than aria-selected: these are not tabs in the ARIA sense - each one is
      // a destination within the item, and the pattern a screen reader should announce is
      // "current", not a tablist we would then owe arrow-key navigation.
      aria-current={active ? 'page' : undefined}
      // The default is a description, not part of the name: a name that changes with state breaks
      // voice control ("click Body") and exact-name queries, while a description is read after it.
      aria-describedby={isDefault ? descriptionId : undefined}
      onClick={onSelect}
      className={[
        // Shrink-free and snapping, so a scrolled strip stops on a tab rather than half of one, and
        // a full touch target on a coarse pointer, where 28px is smaller than a fingertip.
        'relative flex shrink-0 snap-start items-center gap-1.5 whitespace-nowrap border px-2 py-1 text-sm pointer-coarse:min-h-(--control-lg)',
        focusRing,
        active
          ? 'border-divider bg-foreground/7 text-foreground'
          : 'border-transparent text-muted hover:bg-foreground/5',
      ].join(' ')}
    >
      <Icon icon={icon} size="sm" />
      {label}
      {isDefault ? (
        <>
          {/* Absolutely placed in the tab's corner so marking one never changes its width. The dot
              is the eye's cue; the button's description is the same fact for a screen reader. */}
          <span aria-hidden className="absolute right-1 top-1 size-1 rounded-full bg-muted" />
          <span id={descriptionId} hidden>
            Opens by default
          </span>
        </>
      ) : null}
      {broken ? (
        <>
          <Icon icon={TriangleAlert} size="sm" />
          {/* The mark is not colour alone, and it is not icon alone either: a name a screen reader
              reads out has to carry the same warning the eye gets. */}
          <span className="sr-only">(needs attention)</span>
        </>
      ) : null}
    </button>
  );
}
