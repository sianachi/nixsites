import { ArrowUpRight, Check, type LucideIcon } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../lib/cn';
import { blueprintFrame } from '../primitives/Blueprint';
import { Icon } from '../primitives/Icon';
import {
  chromeSurface,
  disabledState,
  focusRingInset,
  inkWashStates,
  isEditableTarget,
} from '../primitives/interaction';
import { useAnchoredPanel } from './use-anchored-panel';

/**
 * <Menu> - a button that discloses a list of actions and links.
 *
 * The WAI-ARIA menu-button pattern, built once so it stops being built once per call site. Two
 * places had it before this existed - the workspace switcher and the profile menu - and each got
 * the same two things wrong on its own: a panel with a literal pixel width that ran off a narrow
 * phone screen, and a trigger sized for a mouse. Fixing both here fixes every menu that adopts it,
 * and the next one for free.
 *
 * **Keyboard.** Enter, Space and ArrowDown open the menu and move focus to its first item (ArrowUp
 * opens onto the last one, the pattern's usual courtesy for "give me the bottom of the list").
 * Inside the open menu, ArrowUp and ArrowDown move between items and wrap at the ends, Home and End
 * jump to the first and last, Escape closes the menu and returns focus to the trigger, and Tab
 * leaves command menus for the next control after the trigger. Ordinary content panels retain
 * their tab order until focus leaves. Typeahead is not implemented -
 * every menu built on this so far is short enough that scanning beats typing.
 *
 * **Dismissal.** A pointerdown outside the trigger and panel closes the menu; so does choosing an
 * item. Neither is optional, because a menu that is still open after you have told it what you
 * want is a menu that does not trust its own list.
 *
 * **Placement.** The panel anchors below the trigger and is measured against
 * `window.visualViewport` - the same source `Dialog.tsx` reads for the on-screen keyboard - so it
 * flips above the trigger when there is not enough room below, and is clamped 8px inside the
 * viewport either way rather than clipped by it. The geometry itself is `placeFloatingMenu`, the
 * same primitive the editor's slash menu, reference picker and bubble menu place themselves
 * with - one tested implementation rather than this component re-deriving its own. Below the `sm`
 * breakpoint the panel becomes a full-width bottom sheet instead,
 * `Dialog.tsx`'s other device concession: a menu is exactly as unable to predict a phone's safe
 * area or its keyboard as a dialog is, so it inherits the same `env(safe-area-inset-bottom)`
 * padding rather than a second, slightly different guess at the same problem.
 *
 * **Items are at least 44px tall under `any-pointer-coarse:`** - `Button.tsx`'s `--control-lg` step, reached
 * the same way: a fine pointer gets the compact row, a finger gets the touch target the platform
 * guidelines ask for.
 *
 * **Destructive tone** darkens the label's weight rather than reaching for a colour: the token
 * sheet carries no danger role today (see `docs/adr/` before adding one - every other tone in this
 * package is a role, not a colour, and a one-off red here would be the first exception), so this is
 * the honest treatment available without inventing a raw value the guide forbids.
 */

export interface MenuAction {
  readonly kind?: 'action';
  /** Stable identity for the list; falls back to `label` when every label in the menu is unique. */
  readonly key?: string;
  readonly label: string;
  /** Decorative - the label already carries the name. */
  readonly icon?: LucideIcon;
  /** Marks a destructive action (leave, delete, sign out) without a colour the system does not have. */
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** The keyboard shortcut that does the same thing, shown after the label - display only. */
  readonly shortcut?: string;
  /**
   * Makes the item a toggle (`menuitemcheckbox`) or one of a set of exclusive choices
   * (`menuitemradio`); `checked` is then required and drawn as a check mark. Selecting still closes
   * the menu, which the menu pattern allows.
   */
  readonly role?: 'menuitemcheckbox' | 'menuitemradio';
  readonly checked?: boolean;
  readonly onSelect: () => void;
}

export interface MenuLink {
  readonly kind: 'link';
  readonly key?: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly destructive?: boolean;
  /** The destination, in the platform's own vocabulary; `renderLink` renames it for a router. */
  readonly href: string;
  /**
   * Leaves the application - an identity provider's account page, say. Drawn as a plain `<a>`
   * opening a new tab, bypassing `renderLink` since no router owns it, and marked so both sighted
   * and screen-reader users know before they click: a trailing arrow and "(opens in a new tab)".
   */
  readonly external?: boolean;
  /** Anything the caller needs to run alongside navigating, beyond closing the menu. */
  readonly onSelect?: () => void;
}

export interface MenuSeparator {
  readonly kind: 'separator';
}

/** Handed to a `content` entry's render function - the one thing bespoke content cannot do for
 * itself, since it did not open the menu. */
interface MenuContentHelpers {
  /** Drops the panel without returning focus to the trigger - the click already moved it. */
  readonly close: () => void;
}

/**
 * Something in the panel that is not a command - an identity block, a settings widget, a region of
 * ordinary navigation links - drawn exactly as given and left out of arrow-key navigation and the
 * roving tabindex, the same way the profile menu's appearance switcher and account header always
 * have been. Its own interactive content (a radio group, a link) keeps its ordinary place in the
 * tab order; it is only the menu's up/down/Home/End model that does not reach it, because none of
 * that model's questions - "which command is this" - have an answer for a fieldset or a region of
 * links to other pages.
 *
 * A function rather than a plain node when that content needs to close the menu itself - a link
 * to another page, say - since only the menu knows how.
 */
export interface MenuContent {
  readonly kind: 'content';
  readonly key?: string;
  readonly content: ReactNode | ((helpers: MenuContentHelpers) => ReactNode);
}

export type MenuEntry = MenuAction | MenuLink | MenuSeparator | MenuContent;

/**
 * What a link item needs to be drawn. The same shape `Nav.tsx`'s `renderLink` uses, for the same
 * reason: this package does not know about routers, so the consumer supplies the routing component
 * and renames `href` to whatever its router calls it in the one line where it renders the link.
 */
export interface MenuLinkRenderProps {
  readonly href: string;
  readonly className: string;
  readonly role: 'menuitem' | undefined;
  readonly tabIndex: 0 | -1;
  readonly children: ReactNode;
  readonly onClick: () => void;
  /**
   * The item's position among the menu's interactive entries, separators excluded. Roving focus
   * finds the active item by this rather than by a stored ref, so a render prop that drops it
   * loses arrow-key nav for that one item rather than the whole menu.
   */
  readonly 'data-menu-item-index': number;
}

/** Handed to the render-prop trigger. Spread directly onto whatever element the caller renders. */
export interface MenuTriggerRenderProps {
  readonly ref: RefObject<HTMLButtonElement | null>;
  readonly type: 'button';
  readonly 'aria-haspopup': 'menu' | 'dialog';
  readonly 'aria-expanded': boolean;
  readonly 'aria-controls': string;
  readonly onClick: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuProps {
  /** The menu's accessible name - what the panel is a menu *of*. */
  readonly label: string;
  readonly items: readonly MenuEntry[];
  /** Renders the trigger. Spread the argument onto a `<Button>` or a plain `<button>`. */
  readonly children: (trigger: MenuTriggerRenderProps) => ReactNode;
  /**
   * Renders one link item. Defaults to a plain `<a>`, correct for an external destination and
   * wrong inside the application - see `Nav.tsx`'s own note on this prop.
   */
  readonly renderLink?: (props: MenuLinkRenderProps) => ReactNode;
  /** Layout only - the panel's own position within its container, never a restyle of the frame. */
  readonly className?: string;
}

function defaultRenderLink(props: MenuLinkRenderProps): ReactNode {
  const { href, children, ...rest } = props;
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

function isInteractive(entry: MenuEntry): entry is MenuAction | MenuLink {
  // A link carries no `disabled` field - a destination you cannot reach is a link that should not
  // be offered, not a link rendered inert - so only an action can take this branch's `disabled`.
  return (
    entry.kind !== 'separator' &&
    entry.kind !== 'content' &&
    !('disabled' in entry && entry.disabled)
  );
}

function panelRole(items: readonly MenuEntry[]): 'menu' | 'dialog' {
  // Ordinary navigation and settings controls cannot be children of an ARIA action menu.
  // A content panel keeps native links/buttons and is announced as a non-modal dialog.
  return items.some((entry) => entry.kind === 'content') || items.length === 0 ? 'dialog' : 'menu';
}

function tabStops(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]',
    ),
  ].filter((element) => {
    if (
      element.tabIndex < 0 ||
      element.matches(':disabled') ||
      element.closest('[hidden], [inert]')
    )
      return false;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- older browsers and jsdom omit this platform method.
    if (!(element.checkVisibility?.() ?? true)) return false;
    if (
      getComputedStyle(element).display === 'none' ||
      getComputedStyle(element).visibility === 'hidden'
    )
      return false;
    return !(
      element instanceof HTMLInputElement &&
      element.type === 'radio' &&
      element.name !== '' &&
      !element.checked &&
      root.querySelector(`input[type="radio"][name="${CSS.escape(element.name)}"]:checked`)
    );
  });
}

const itemClass = cn(
  'flex min-h-(--control-md) w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground',
  'any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:text-base',
  inkWashStates,
  focusRingInset,
  disabledState,
);

export function Menu(props: MenuProps): ReactNode {
  const { label, items, children, renderLink, className } = props;

  const panelId = useId();
  const [open, setOpen] = useState<{ initial: 'first' | 'last'; host: HTMLElement } | null>(null);
  // Bumped whenever a close should hand focus back to the trigger. A counter rather than a plain
  // boolean so two closes in a row - vanishingly unlikely, but free to handle - each still fire the
  // effect below, and a token rather than a direct ref read here: every path that can close the
  // menu is reachable from inside the rendered item list, and reading `triggerRef.current` from
  // there is a render-time ref access. Moving the read into its own effect, keyed on this token,
  // is what keeps it one.
  const [focusReturnToken, setFocusReturnToken] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  function disclosure(initial: 'first' | 'last'): { initial: 'first' | 'last'; host: HTMLElement } {
    // Escape pane stacking/scroll containment, while staying in a native modal's top layer.
    return {
      initial,
      host: triggerRef.current?.closest<HTMLElement>('dialog[open]') ?? document.body,
    };
  }

  useEffect(() => {
    if (focusReturnToken === 0 || document.activeElement !== document.body) return;
    triggerRef.current?.focus({ preventScroll: true });
  }, [focusReturnToken]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(disclosure('first'));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(disclosure('last'));
    }
  };

  return (
    <>
      {children({
        ref: triggerRef,
        type: 'button',
        'aria-haspopup': panelRole(items),
        'aria-expanded': open !== null,
        'aria-controls': panelId,
        onClick: () => {
          const next = disclosure('first');
          setOpen((current) => (current === null ? next : null));
        },
        onKeyDown: onTriggerKeyDown,
      })}

      {open !== null
        ? createPortal(
            <MenuPanel
              id={panelId}
              label={label}
              items={items}
              initial={open.initial}
              renderLink={renderLink}
              className={className}
              ignoreOutside={triggerRef}
              anchor={() => {
                const rect = triggerRef.current?.getBoundingClientRect();
                return rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null;
              }}
              onClose={(returnFocus) => {
                setOpen(null);
                if (returnFocus) setFocusReturnToken((token) => token + 1);
              }}
            />,
            open.host,
          )
        : null}
    </>
  );
}

/** What a panel is anchored to: a trigger's rectangle, or the point a context menu opened at. */
export interface MenuPanelAnchor {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

export interface MenuPanelProps {
  readonly id?: string;
  readonly label: string;
  readonly items: readonly MenuEntry[];
  /** Which interactive entry takes focus first. */
  readonly initial: 'first' | 'last';
  readonly renderLink?: ((props: MenuLinkRenderProps) => ReactNode) | undefined;
  readonly className?: string | undefined;
  /** Read on open and on every viewport change; `null` leaves the panel where it is. */
  readonly anchor: () => MenuPanelAnchor | null;
  /** A pointerdown inside this element is not an outside click - the trigger toggles itself. */
  readonly ignoreOutside?: RefObject<HTMLElement | null>;
  /** Keyboard exit follows the invoking control rather than the portal's document position. */
  readonly tabOrigin?: HTMLElement | null;
  /** `returnFocus` is true for a choice or Escape, false for Tab, an outside click or a content close. */
  readonly onClose: (returnFocus: boolean) => void;
}

/**
 * The open panel shared by `<Menu>` and `<ContextMenu>`: the item list, roving focus, keyboard
 * model, outside-click dismissal and placement. Rendered only while open, so its state starts
 * fresh each time. Not exported from the package - a consumer wants one of the two components.
 */
export function MenuPanel(props: MenuPanelProps): ReactNode {
  const {
    id,
    label,
    items,
    initial,
    renderLink = defaultRenderLink,
    className,
    anchor,
    ignoreOutside,
    tabOrigin,
    onClose,
  } = props;

  const panelRef = useRef<HTMLDivElement>(null);
  const role = panelRole(items);

  // Indices into `items` - not a separate numbering - so `activeIndex` always names one entry
  // directly, with no second translation table between "which item" and "which interactive item".
  const enabledIndices = items.reduce<number[]>(
    (acc, entry, index) => (isInteractive(entry) ? [...acc, index] : acc),
    [],
  );
  const firstEnabled = enabledIndices.length > 0 ? enabledIndices[0] : undefined;
  const lastEnabled =
    enabledIndices.length > 0 ? enabledIndices[enabledIndices.length - 1] : undefined;
  const enabledCount = enabledIndices.length;
  const [activeIndex, setActiveIndex] = useState(
    () => (initial === 'first' ? firstEnabled : lastEnabled) ?? 0,
  );

  // The latest callbacks, read by effects that must not re-run - and re-place or re-bind - every
  // time a caller passes a fresh closure.
  const latest = useRef({ onClose });
  useEffect(() => {
    latest.current = { onClose };
  });

  const moveActive = (direction: 1 | -1): void => {
    if (enabledIndices.length === 0) return;
    const position = enabledIndices.indexOf(activeIndex);
    const nextPosition =
      (position === -1 ? 0 : position + direction + enabledIndices.length) % enabledIndices.length;
    const next = enabledIndices[nextPosition];
    if (next !== undefined) setActiveIndex(next);
  };

  const select = (entry: MenuAction | MenuLink): void => {
    if (entry.kind === 'link') {
      entry.onSelect?.();
    } else {
      entry.onSelect();
    }
    onClose(true);
  };

  // Focus follows the active index while the menu is open, so arrow keys move real focus rather
  // than a visual-only highlight a screen reader has no way to hear. Found by the item's own
  // position marker rather than a stored ref, so a caller's `renderLink` only has to carry one
  // data attribute through to keep its item in the roving order.
  useEffect(() => {
    const item = panelRef.current?.querySelector<HTMLElement>(
      `[data-menu-item-index="${String(activeIndex)}"]`,
    );
    if (item && enabledCount > 0) {
      item.focus();
    } else if (enabledCount === 0) {
      const controls = panelRef.current ? tabStops(panelRef.current) : [];
      const control = initial === 'last' ? controls[controls.length - 1] : controls[0];
      (control ?? panelRef.current)?.focus();
    }
  }, [activeIndex, enabledCount, initial]);

  // Outside pointerdown closes the menu, the same as every other disclosure in this package.
  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (ignoreOutside?.current?.contains(target) === true) return;
      if (panelRef.current?.contains(target) === true) return;
      // Not a return-focus close: the click already moved focus wherever the pointer landed.
      latest.current.onClose(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [ignoreOutside]);

  // Placement: anchored below its anchor, flipped above and clamped 8px inside the visual
  // viewport - see `<Menu>`'s doc comment for why `visualViewport` and not `window` alone.
  useAnchoredPanel(panelRef, anchor, items.length);

  // Attached once, to the panel, rather than once per item: it is what lets Escape close the menu
  // from a `content` entry's own controls (the profile menu's appearance radios, the workspace
  // switcher's plain links) exactly as it does from a real item, without those entries having to
  // know this component's key model exists. Arrow keys, Home and End stay scoped to real items -
  // read off the target's command marker, not off which handler fired - so they never fight a radio
  // group's native left/right cycling for the same keys.
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Stops here, at the panel, rather than reaching a document- or window-level Escape
      // handler outside it (a dialog this menu sits inside, `sidebar-drawer.tsx`'s own listener
      // on `window`) - see that component's note on the convention: the innermost open thing
      // wins, and it wins by stopping propagation at its own node rather than by racing to
      // attach its listener first.
      event.stopPropagation();
      onClose(true);
      return;
    }

    if (event.key === 'Tab') {
      const panel = panelRef.current;
      const stops = panel ? tabStops(panel) : [];
      const target = event.target;
      const leaving =
        role === 'menu' ||
        (event.shiftKey ? target === stops[0] : target === stops[stops.length - 1]);
      if (leaving) {
        const origin = ignoreOutside?.current ?? tabOrigin ?? null;
        if (origin) {
          event.preventDefault();
          const root = origin.closest<HTMLElement>('dialog[open]') ?? document.body;
          const outside = tabStops(root).filter((control) => !panel?.contains(control));
          const next = event.shiftKey
            ? origin
            : (outside[outside.indexOf(origin) + 1] ?? outside[0] ?? origin);
          onClose(false);
          next.focus({ preventScroll: true });
        } else {
          onClose(false);
        }
      }
      return;
    }

    if (!(event.target as HTMLElement).hasAttribute('data-menu-item-index')) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        if (firstEnabled !== undefined) setActiveIndex(firstEnabled);
        break;
      case 'End':
        event.preventDefault();
        if (lastEnabled !== undefined) setActiveIndex(lastEnabled);
        break;
      default:
        break;
    }
  };

  const panelClass = cn(
    blueprintFrame,
    'fixed inset-auto z-50 m-0 flex flex-col overflow-y-auto bg-background px-0 py-1 font-body text-foreground shadow-md',
    chromeSurface,
    // design-token-exempt: 220px is a minimum reading measure for a short label list, the same
    // category as `Dialog.tsx`'s 560px - not a step on any scale.
    'min-w-[220px] max-w-[calc(100vw-16px)]',
    // Below `sm` the panel drops the anchored position entirely and becomes a bottom sheet: full
    // width, safe-area padding, same device concession as `Dialog.tsx`'s `presentation="standard"`.
    'max-sm:rounded-b-none max-sm:pb-[max(var(--spacing)*1,env(safe-area-inset-bottom))]',
    className,
  );

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- role is menu or dialog; this handler coordinates keyboard navigation among their controls.
    <div
      id={id}
      ref={panelRef}
      popover="manual"
      role={role}
      aria-label={label}
      // Escape remains reachable when every command is disabled.
      tabIndex={-1}
      className={panelClass}
      onKeyDown={onPanelKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose(false);
      }}
      onContextMenu={(event) => {
        if (!isEditableTarget(event.target)) event.preventDefault();
      }}
    >
      {items.map((entry, index) => {
        if (entry.kind === 'separator') {
          return (
            <div
              key={`separator-${String(index)}`}
              role="separator"
              className="my-1 border-t border-divider"
            />
          );
        }

        if (entry.kind === 'content') {
          const node =
            typeof entry.content === 'function'
              ? entry.content({
                  close: () => {
                    onClose(false);
                  },
                })
              : entry.content;
          return <Fragment key={entry.key ?? `content-${String(index)}`}>{node}</Fragment>;
        }

        const tone = entry.destructive === true ? 'font-semibold' : undefined;
        const tabIndex = role === 'dialog' || index === activeIndex ? 0 : -1;
        const key = entry.key ?? entry.label;

        if (entry.kind === 'link' && entry.external === true) {
          return (
            <a
              key={key}
              href={entry.href}
              target="_blank"
              rel="noopener noreferrer"
              role={role === 'menu' ? 'menuitem' : undefined}
              tabIndex={tabIndex}
              className={cn(itemClass, tone)}
              onClick={() => {
                select(entry);
              }}
              data-menu-item-index={index}
            >
              {entry.icon ? <Icon icon={entry.icon} size="sm" /> : null}
              <span className="min-w-0 flex-1 break-words">
                {entry.label} <span className="sr-only">(opens in a new tab)</span>
              </span>
              <span className="ml-auto text-muted">
                <Icon icon={ArrowUpRight} size="sm" />
              </span>
            </a>
          );
        }

        if (entry.kind === 'link') {
          return (
            <Fragment key={key}>
              {renderLink({
                href: entry.href,
                role: role === 'menu' ? 'menuitem' : undefined,
                tabIndex,
                className: cn(itemClass, tone),
                onClick: () => {
                  select(entry);
                },
                children: (
                  <>
                    {entry.icon ? <Icon icon={entry.icon} size="sm" /> : null}
                    <span className="min-w-0 flex-1 break-words">{entry.label}</span>
                  </>
                ),
                'data-menu-item-index': index,
              })}
            </Fragment>
          );
        }

        return (
          <button
            key={key}
            type="button"
            role={role === 'menu' ? (entry.role ?? 'menuitem') : undefined}
            aria-checked={role === 'menu' && entry.role ? entry.checked === true : undefined}
            tabIndex={tabIndex}
            disabled={entry.disabled}
            data-menu-item-index={index}
            className={cn(itemClass, tone)}
            onClick={() => {
              select(entry);
            }}
          >
            {entry.role ? (
              // Reserved even when unchecked, so labels stay aligned; the state is aria-checked.
              <span aria-hidden className={entry.checked === true ? undefined : 'invisible'}>
                <Icon icon={Check} size="sm" />
              </span>
            ) : null}
            {entry.icon ? <Icon icon={entry.icon} size="sm" /> : null}
            <span className="min-w-0 flex-1 break-words">{entry.label}</span>
            {entry.shortcut ? (
              <kbd aria-hidden="true" className="font-body text-xs text-muted">
                {entry.shortcut}
              </kbd>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
