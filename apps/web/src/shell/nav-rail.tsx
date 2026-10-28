import { Button, Icon, Menu, Text, chromeSurface, focusRing, type MenuEntry } from '@nix/ui';
import {
  Bookmark,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  FolderInput,
  House,
  LayoutTemplate,
  ListFilter,
  ListFilterPlus,
  Network,
  PawPrint,
  Settings,
  Trash2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

import {
  useForgetDeletedSmartLists,
  useKnownSmartLists,
  useKnownSmartListsStore,
  type KnownSmartList,
} from '../views/query/known-smart-lists';

import { petAttentionText } from '../pets/pet-attention';
import { useSelectedItem } from '@nix/web-platform/routing/selected-item';
import { usePetNavEntry } from '../pets/use-pet-nav-entry';
import { useWorkspace } from '../workspaces/workspace-context';

/**
 * The navigation rail: the handful of ways to look at the whole workspace at once.
 *
 * A workspace tree answers "which note", one at a time. Calendar, Graph and Bookmarks each answer
 * a different question about every note together - which is why none of them is an item in the
 * tree, and why they need a destination of their own rather than a row inside it. Notes sits beside
 * them as the tree's own destination, so the upper group names a complete set of ways into the
 * workspace rather than three extras bolted beside an unlabelled default. Import and Settings sit
 * at the foot: persistent workspace operations rather than views. Desktop keeps a strip beside
 * the tree; compact layouts use one destination menu inside the workspace drawer.
 *
 * ## Why this lives in the app and not in `packages/ui`
 *
 * `<Nav>` (packages/ui/src/controls/Nav.tsx) is already the design system's "a list of links, one
 * of which may be the page you are on", and this is deliberately not it. Two things differ, and
 * both are product facts rather than design-system ones. `<Nav>` requires a visible label per item
 * - correctly, for a settings sidebar - while the desktop rail is icon-only beside the tree,
 * carrying its name for assistive technology alone. The compact menu provides visible labels
 * and saves drawer width. And a rail is one tab stop
 * with the arrow keys moving inside it, which `<Nav>` does not do and should not learn for a single
 * caller. What is left after those two is a component that knows this application's own destinations
 * and imports this application's router, neither of which belongs in a package that `apps/*` depend
 * on.
 *
 * ## Keyboard: one tab stop, arrows inside
 *
 * The APG's roving tabindex, the same convention `views/calendar/use-roving-grid.ts` implements for the
 * hour grid, and for the same reason: a set of like controls should cost one Tab press to pass,
 * not one per control. Seven controls make that a real saving today and a correct habit regardless
 * - the rail is where persistent workspace controls accumulate.
 *
 * It is spelled out here rather than reusing that hook, which is built for a grid whose slots the
 * caller does not render (it finds buttons by `querySelector` and writes `tabindex` onto the DOM,
 * precisely because `CreateItemControl` exposes no tabindex prop). This component renders its own
 * links and button, so the entry point is a prop it passes, not an attribute it has to reach into
 * the DOM to set. Down/Up move by one and Home/End jump to the ends, all clamped rather than
 * wrapped - the same no-wrap choice the grid makes, so the ends of a keyboard-navigable set are
 * findable by feel everywhere in the product.
 *
 * ## Where you are is never colour alone
 *
 * The current destination carries `aria-current="page"`, which is the only signal that reaches
 * somebody who cannot see the accent wash. Same contract, and same reasoning, as `<Nav>`'s.
 */

interface RailItemBase {
  /**
   * The accessible name, rendered as visually hidden text rather than an `aria-label`: real text
   * content is what a translation pass, a browser's find-in-page, and every accessible-name
   * calculation agree on. Also given as `title`, so a pointer user can discover what an unlabelled
   * glyph means without a tooltip component.
   */
  readonly label: string;

  /**
   * Something at this destination is waiting on the person: drawn as a dot on the glyph and said
   * in words after the label, so it is not carried by a mark alone.
   */
  readonly attention?: string;

  readonly icon: LucideIcon;

  /** Utility controls are pinned to the foot, away from the workspace views. */
  readonly group: 'workspace' | 'utility';
}

interface RailDestination extends RailItemBase {
  readonly kind: 'destination';
  /** The route. Also the identity used to decide which destination is current. */
  readonly to: string;
  /** Nested screens such as the template studio still belong to their parent destination. */
  readonly includesChildren?: boolean;

  /**
   * A pinned smart list's initial, drawn over its glyph: every pinned list shares one icon, so
   * the letter is what tells two of them apart before the label is read.
   */
  readonly monogram?: string;
}

interface RailAction extends RailItemBase {
  readonly kind: 'action';
  /**
   * `import` opens the import dialog; `queries` opens the Smart lists menu - the smart lists this
   * browser has opened, pin and unpin, and "New smart list" (plan 1.8).
   */
  readonly action: 'import' | 'queries';
}

type RailItem = RailDestination | RailAction;

/**
 * The controls, in the order they appear.
 *
 * **Homebase is first, and it is the only destination that is not a different kind of workspace view.**
 * Calendar, Graph and Bookmarks each collapse the whole workspace into one picture drawn a
 * different way; Homebase is the workspace with nothing open - the one destination that is not
 * really "elsewhere", only home. Placing it first, rather than leaving `/` reachable only through the logo, is what
 * makes the rail read as a complete set of destinations instead of three extra ones bolted beside
 * an unlabelled default.
 *
 * `Network` rather than `Workflow` for the graph: a workflow glyph is a flowchart - boxes in a
 * sequence, with a direction - and the link graph has neither. `Network`'s undirected nodes and
 * edges are what the view actually shows.
 */
/**
 * The Smart lists control: a menu rather than a destination, because smart lists are items and each
 * already has an address - what the rail adds is a way to reach them from anywhere and to keep the
 * ones somebody uses every day one press away, as pinned entries beside it.
 */
const QUERIES_ITEM: RailAction = {
  kind: 'action',
  action: 'queries',
  label: 'Smart lists',
  icon: ListFilterPlus,
  group: 'workspace',
};

const page = (
  group: RailItemBase['group'],
  to: string,
  label: string,
  icon: LucideIcon,
  includesChildren?: true,
): RailDestination => ({
  kind: 'destination',
  to,
  label,
  icon,
  group,
  ...(includesChildren ? { includesChildren } : {}),
});

const PET_ITEM = page('workspace', '/pet', 'Pet', PawPrint);

const ITEMS: readonly RailItem[] = [
  page('workspace', '', 'Homebase', House),
  page('workspace', '/daily', 'Daily notes', CalendarClock),
  page('workspace', '/calendar', 'Calendar', CalendarDays),
  page('workspace', '/graph', 'Graph', Network),
  page('workspace', '/bookmarks', 'Bookmarks', Bookmark),
  page('workspace', '/templates', 'Templates', LayoutTemplate, true),
  QUERIES_ITEM,
  page('utility', '/automations', 'Automations', Zap),
  page('utility', '/trash', 'Trash', Trash2),
  { kind: 'action', action: 'import', label: 'Import', icon: FolderInput, group: 'utility' },
  page('utility', '/settings', 'Settings', Settings),
];

export interface NavRailProps {
  /**
   * Called after a destination is followed. The shell uses it to dismiss the narrow-viewport
   * drawer, which would otherwise stay open over the destination it was just asked to leave for.
   */
  readonly onNavigate?: () => void;

  /** Opens the workspace-level import flow. It is an action, so it does not change the address. */
  readonly onImport: () => void;
  readonly compact?: boolean;
}

export function NavRail({ onNavigate, onImport, compact = false }: NavRailProps): ReactNode {
  const { pathname } = useLocation();
  const { selectedId } = useSelectedItem();
  const { workspaceId, workspace } = useWorkspace();
  const workspaceRoot = `/w/${workspaceId}`;
  const petEntry = usePetNavEntry();
  const dailyItems = workspace.canUseDailyNotes
    ? ITEMS
    : ITEMS.filter((item) => item.kind !== 'destination' || item.to !== '/daily');
  // The pet page is offered only while this device's preference and a switched-on companion call
  // for it, so it is added to the list rather than declared in it. It sits after Bookmarks, the
  // last of the whole-workspace views, ahead of Templates and the tools.
  const petItems: readonly RailItem[] = petEntry
    ? dailyItems.flatMap((item) =>
        item.kind === 'destination' && item.to === '/bookmarks'
          ? [
              item,
              {
                ...PET_ITEM,
                label: petEntry.label,
                ...(petEntry.attention === null
                  ? {}
                  : { attention: petAttentionText(petEntry.attention) }),
              },
            ]
          : [item],
      )
    : dailyItems;
  // Pinned smart lists sit right after the Smart lists control, as destinations of their own: an item
  // address rather than a route, so none is ever "current" by pathname, which is right - the item
  // page is Notes, whichever list it was reached from.
  const smartLists = useKnownSmartLists(workspaceId);
  useForgetDeletedSmartLists();
  const items: readonly RailItem[] = withPinnedQueries(petItems, smartLists);

  // Which control is the rail's single tab stop. Null until somebody has actually put focus in here,
  // so the entry point is the current destination by default - derived from the URL rather than
  // copied into state, which keeps it right after a navigation the rail did not make.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // Identity is a dependency of `.focus()` - the arrow keys have to move focus to an element this
  // component rendered, and there is no other way to reach it. `useRef` over `useState` because
  // filling this in must not re-render.
  const controlRefs = useRef<(HTMLAnchorElement | HTMLButtonElement | null)[]>([]);

  const currentIndex = items.findIndex(
    (item) =>
      item.kind === 'destination' &&
      (item.includesChildren === true
        ? pathname === `${workspaceRoot}${item.to}` ||
          pathname.startsWith(`${workspaceRoot}${item.to}/`)
        : item.to === ''
          ? // Homebase is the root address with nothing open; an open note is not Homebase.
            selectedId === null && (pathname === workspaceRoot || pathname === `${workspaceRoot}/`)
          : pathname === `${workspaceRoot}${item.to}`),
  );
  const entryIndex =
    focusedIndex === null ? Math.max(currentIndex, 0) : Math.min(focusedIndex, items.length - 1);

  // Handled on the control rather than on the list around it: a key press acts from wherever focus
  // actually is, and hanging a keyboard listener on a `<ul>` would be putting interaction on an
  // element with no interactive role (which `jsx-a11y/no-noninteractive-element-interactions` says
  // out loud, correctly - a listener there is only reachable because a real control inside it
  // bubbled the event).
  function onKeyDown(event: KeyboardEvent<HTMLElement>, from: number): void {
    let next = from;

    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(from + 1, items.length - 1);
        break;
      case 'ArrowUp':
        next = Math.max(from - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }

    // The rail must not also scroll the page: one press, one movement.
    event.preventDefault();
    setFocusedIndex(next);
    controlRefs.current[next]?.focus();
  }

  if (compact) {
    const currentItem = items[currentIndex];
    const currentHref =
      currentItem?.kind === 'destination' ? `${workspaceRoot}${currentItem.to}` : null;
    // The compact menu is already a menu, so the Smart lists control's own entries are folded into it
    // at the end rather than nested as a second menu inside the first.
    const entries: MenuEntry[] = [
      ...items.flatMap((item): MenuEntry[] =>
        item.kind === 'destination' && item.monogram !== undefined
          ? []
          : item.kind === 'destination'
            ? [
                {
                  kind: 'link',
                  label: item.label,
                  icon: item.icon,
                  href: `${workspaceRoot}${item.to}`,
                  onSelect: () => {
                    onNavigate?.();
                  },
                },
              ]
            : item.action === 'queries'
              ? []
              : [{ kind: 'action', label: item.label, icon: item.icon, onSelect: onImport }],
      ),
      { kind: 'separator' },
      ...queriesMenuEntries(workspaceId, workspaceRoot, smartLists, onNavigate),
    ];
    return (
      <nav aria-label="Destinations">
        <Menu
          label="Workspace pages"
          items={entries}
          renderLink={({ href, ...props }) => (
            <Link to={href} {...props} aria-current={href === currentHref ? 'page' : undefined} />
          )}
        >
          {(trigger) => (
            <Button {...trigger} variant="ghost" className="w-full justify-between">
              {items[currentIndex]?.label ?? 'Workspace pages'}
              <Icon icon={ChevronDown} size="sm" />
            </Button>
          )}
        </Menu>
      </nav>
    );
  }

  return (
    // `bg-surface`, the same ground the tree sits on: the rail stretches the full height of the
    // shell, past the header above the tree as well as beside the tree itself, and one surface for
    // that whole strip is what keeps it reading as one region rather than two stacked patches.
    // Because that surface is the one the tree already sits on, the two would have no boundary at
    // all where they meet - AGENTS.md's own case for `border-divider`, reached for "only where two
    // regions of the same colour genuinely meet". The border runs the rail's full height rather
    // than only alongside the tree, so it stays one continuous line rather than a border that
    // starts partway down. Named, because a shell with a rail and a workspace tree has more than
    // one way to move around and "navigation, navigation" is not a landmark list anybody can use.
    <nav
      aria-label="Destinations"
      className={`flex min-h-0 shrink-0 overflow-y-auto overscroll-contain border-r border-divider bg-surface ${chromeSurface}`}
    >
      <ul className="flex min-h-0 flex-1 list-none flex-col items-center gap-1 px-1 py-2 max-lg:items-stretch max-lg:px-2">
        {items.map((item, index) => {
          const current = index === currentIndex;
          const startsUtilityGroup =
            item.group === 'utility' && items[index - 1]?.group !== 'utility';
          const sharedProps = {
            title: item.attention ? `${item.label} (${item.attention})` : item.label,
            tabIndex: index === entryIndex ? 0 : -1,
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
              onKeyDown(event, index);
            },
            onFocus: () => {
              // Keeps the tab stop where focus really is, including after a pointer click,
              // so tabbing out and back returns to where the person just was.
              setFocusedIndex(index);
            },
          };
          const className = `flex size-(--control-lg) items-center justify-center gap-3 rounded-md max-lg:h-(--control-lg) max-lg:w-full max-lg:justify-start max-lg:px-3 ${focusRing} ${
            current
              ? // The wash is a filled shape where the others have none, so the current
                // destination is not told apart by hue alone even before `aria-current`.
                'bg-accent/15 text-accent-text'
              : 'text-muted hover:bg-foreground/7 hover:text-foreground'
          }`;

          return (
            <li
              key={item.kind === 'destination' ? item.to : item.action}
              className={startsUtilityGroup ? 'mt-auto' : undefined}
            >
              {item.kind === 'destination' ? (
                <Link
                  ref={(node) => {
                    controlRefs.current[index] = node;
                  }}
                  to={`${workspaceRoot}${item.to}`}
                  aria-current={current ? 'page' : undefined}
                  onClick={onNavigate}
                  className={
                    item.monogram === undefined ? className : `group relative ${className}`
                  }
                  {...sharedProps}
                >
                  <span className="relative shrink-0">
                    {item.monogram === undefined ? (
                      <Icon icon={item.icon} size="sm" />
                    ) : (
                      // The list's initial in place of the shared glyph, so two pinned lists are
                      // told apart at a glance; the label below is what is announced.
                      <span
                        aria-hidden="true"
                        className="inline-flex size-4 items-center justify-center rounded-sm border border-current"
                      >
                        <Text as="span" variant="kicker">
                          {item.monogram}
                        </Text>
                      </span>
                    )}
                    {item.attention ? (
                      <span
                        aria-hidden="true"
                        className="absolute -right-1 -top-1 size-2 rounded-full bg-accent-fill"
                      />
                    ) : null}
                  </span>
                  <Text
                    as="span"
                    variant="body"
                    truncate
                    className={
                      item.monogram === undefined
                        ? 'sr-only max-lg:not-sr-only'
                        : // A pinned list's name appears beside the rail while it has keyboard
                          // focus: a letter alone does not say which list it is.
                          'sr-only group-focus-visible:not-sr-only group-focus-visible:absolute group-focus-visible:left-full group-focus-visible:z-10 group-focus-visible:ml-2 group-focus-visible:whitespace-nowrap group-focus-visible:rounded-md group-focus-visible:border group-focus-visible:border-divider group-focus-visible:bg-surface group-focus-visible:px-2 group-focus-visible:py-1 max-lg:not-sr-only max-lg:static'
                    }
                  >
                    {item.label}
                    {item.attention ? <span className="sr-only">, {item.attention}</span> : null}
                  </Text>
                </Link>
              ) : item.action === 'queries' ? (
                <Menu
                  label="Smart lists"
                  items={queriesMenuEntries(workspaceId, workspaceRoot, smartLists, onNavigate)}
                  renderLink={({ href, ...props }) => <Link to={href} {...props} />}
                >
                  {(trigger) => (
                    <button
                      {...trigger}
                      ref={(node) => {
                        controlRefs.current[index] = node;
                        trigger.ref.current = node;
                      }}
                      className={className}
                      {...sharedProps}
                      onKeyDown={(event) => {
                        // The rail's arrows move between its controls; every other key - Enter,
                        // Space - is the menu trigger's own.
                        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                          onKeyDown(event, index);
                        } else {
                          trigger.onKeyDown(event);
                        }
                      }}
                    >
                      <Icon icon={item.icon} size="sm" className="shrink-0" />
                      <Text
                        as="span"
                        variant="body"
                        truncate
                        className="sr-only max-lg:not-sr-only"
                      >
                        {item.label}
                      </Text>
                    </button>
                  )}
                </Menu>
              ) : (
                <button
                  ref={(node) => {
                    controlRefs.current[index] = node;
                  }}
                  type="button"
                  onClick={onImport}
                  className={className}
                  {...sharedProps}
                >
                  <Icon icon={item.icon} size="sm" className="shrink-0" />
                  <Text as="span" variant="body" truncate className="sr-only max-lg:not-sr-only">
                    {item.label}
                  </Text>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The rail's items with each pinned smart list placed right after the Smart lists control. */
function withPinnedQueries(
  items: readonly RailItem[],
  smartLists: readonly KnownSmartList[],
): readonly RailItem[] {
  const pinned: RailDestination[] = smartLists
    .filter((list) => list.pinned)
    .map((list) => ({
      kind: 'destination',
      to: `?item=${encodeURIComponent(list.id)}`,
      label: list.title.length > 0 ? list.title : 'Untitled smart list',
      icon: ListFilter,
      group: 'workspace',
      monogram: (list.title.trim()[0] ?? '?').toUpperCase(),
    }));
  return items.flatMap((item) =>
    item.kind === 'action' && item.action === 'queries' ? [item, ...pinned] : [item],
  );
}

/**
 * What the Smart lists menu offers: the smart lists this browser has opened, a pin or unpin for
 * each, and "New smart list". The first entry always says the list is the ones opened here - see
 * `known-smart-lists.ts` for why there is no workspace-wide read behind it yet.
 */
function queriesMenuEntries(
  workspaceId: string,
  workspaceRoot: string,
  smartLists: readonly KnownSmartList[],
  onNavigate: (() => void) | undefined,
): MenuEntry[] {
  const { setPinned } = useKnownSmartListsStore.getState();
  const named = (list: KnownSmartList): string =>
    list.title.length > 0 ? list.title : 'Untitled smart list';
  return [
    // Always first, and disabled: the list is the smart lists this browser has opened, never the
    // workspace's complete set, and this says so before anything else in the menu. A disabled
    // command rather than a heading, because free content would turn the menu into a dialog.
    {
      kind: 'action',
      key: 'queries-scope',
      label:
        smartLists.length === 0
          ? 'Smart lists opened in this browser: none yet'
          : 'Smart lists opened in this browser',
      disabled: true,
      onSelect: () => undefined,
    },
    ...smartLists.map((list): MenuEntry => ({
      kind: 'link',
      key: `open-${list.id}`,
      label: named(list),
      icon: ListFilter,
      href: `${workspaceRoot}?item=${encodeURIComponent(list.id)}`,
      onSelect: () => {
        onNavigate?.();
      },
    })),
    ...(smartLists.length === 0 ? [] : [{ kind: 'separator' } as const]),
    ...smartLists.map((list): MenuEntry => ({
      kind: 'action',
      key: `pin-${list.id}`,
      label: list.pinned
        ? `Unpin ${named(list)} from this browser's rail`
        : `Pin ${named(list)} to this browser's rail`,
      onSelect: () => {
        setPinned(workspaceId, list.id, !list.pinned);
      },
    })),
    { kind: 'separator' },
    {
      kind: 'link',
      key: 'new-query',
      label: 'New smart list',
      icon: ListFilterPlus,
      href: `${workspaceRoot}/new/query`,
      onSelect: () => {
        onNavigate?.();
      },
    },
  ];
}
