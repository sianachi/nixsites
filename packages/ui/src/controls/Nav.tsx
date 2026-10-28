import { cva } from 'class-variance-authority';
import { type LucideIcon } from 'lucide-react';
import { type ReactElement, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../primitives/Icon';
import { focusRing, inkWashStates } from '../primitives/interaction';

/**
 * <Nav> - a list of links, one of which may be the page you are on.
 *
 * Used for the settings area today and for in-page section navigation later, in two orientations:
 * a rail down the side and a row of tabs across the top. The two are the same component because
 * they are the same thing - a set of destinations with one current - and splitting them would let
 * the current-item marking drift apart between them.
 *
 * **The current item is marked with `aria-current="page"`, never with colour alone.** A person who
 * cannot see the accent rule still needs to know where they are, and `aria-current` is the only
 * signal that reaches them. The rule and the accent text are the sighted half of the same fact.
 *
 * **Which item is current is not this component's business.** `currentHref` is compared against
 * each item's `href`, so the answer comes from one place - the router, which is the only thing that
 * knows what the URL matched. A per-item `current` flag would let two items both claim it, and a
 * nav with two current items is a nav that is lying to somebody.
 *
 * The links are real links. A nav whose items are buttons with click handlers cannot be
 * middle-clicked, copied, or opened in a new tab, and browsers rightly refuse to treat it as
 * navigation.
 */

/**
 * What a link needs to be drawn. Handed to `renderLink` so the consumer supplies the routing
 * component without this package learning about routers.
 *
 * `href` rather than `to` because that is what the platform calls it; a react-router consumer
 * renames it in the one line where it renders the link. That rename is exactly why this is a render
 * prop and not an `as` element: react-router's `Link` takes `to`, so swapping the tag alone would
 * hand it an `href` it ignores and produce a link that goes nowhere.
 */
interface NavLinkRenderProps {
  readonly href: string;
  readonly className: string;
  /** Present only on the item the router matched. */
  readonly 'aria-current': 'page' | undefined;
  readonly children: ReactNode;
}

export interface NavItem {
  /** The destination. Also the identity used to decide which item is current. */
  readonly href: string;
  /** The visible text. A nav item without visible text is a puzzle, so this is not optional. */
  readonly label: string;
  /**
   * A glyph beside the label. Decorative by construction: the label is already the accessible
   * name, and naming the icon as well would make assistive technology say the item twice.
   */
  readonly icon?: LucideIcon;
}

type NavOrientation = 'horizontal' | 'vertical';

export interface NavProps {
  /**
   * Names the navigation landmark. Required, because a page with a sidebar and a tab strip has two
   * of them, and "navigation, navigation" is not a landmark list anyone can use.
   */
  readonly label: string;

  readonly items: readonly NavItem[];

  /** The URL the router matched. An item whose `href` equals it becomes the current one. */
  readonly currentHref?: string;

  readonly orientation?: NavOrientation;

  /**
   * Renders one link. Defaults to a plain `<a>`, which is right for an external destination and
   * wrong inside the application, where the consumer passes its router's link instead:
   *
   *     renderLink={({ href, ...rest }) => <Link to={href} {...rest} />}
   */
  readonly renderLink?: (props: NavLinkRenderProps) => ReactElement;

  /** Layout only - margin, width, grid placement. Never a restyle of the list. */
  readonly className?: string;
}

/**
 * The rule that runs the length of the nav, and the segment of it each item owns.
 *
 * The current item is drawn by thickening its own segment of that rule to 2px of accent and
 * pulling it over the hairline, so nothing moves when the current item changes: the marking is a
 * colour swap on an element that was always there, not a border that appears and reflows the row.
 */
const navListVariants = cva('flex list-none', {
  variants: {
    orientation: {
      horizontal: 'flex-row items-stretch gap-1 border-b border-divider',
      vertical: 'flex-col items-stretch gap-px border-l border-divider',
    },
  },
  defaultVariants: { orientation: 'vertical' },
});

const navItemVariants = cva(
  cn(
    'flex items-center gap-2 no-underline transition-colors any-pointer-coarse:min-h-(--control-lg)',
    'font-heading text-base font-medium tracking-slight',
    focusRing,
  ),
  {
    variants: {
      orientation: {
        horizontal: '-mb-px border-b-2 px-3 pt-2 pb-2',
        vertical: '-ml-px border-l-2 py-2 pr-3 pl-3',
      },
      current: {
        // The rule and the text are the same role, which is what keeps them one mark rather than
        // two colours that have to be kept in step. It is a state indicator, so the floor is 3:1;
        // the ramp step this used to name reads 2.7:1 on the dark ground, and the role reads
        // 5.8:1 on paper and 12.1:1 on ink.
        true: 'border-accent-text text-accent-text',
        // The ink wash rather than the accent one: a hover is a maybe, and tinting it with the
        // accent would make every item look briefly current.
        false: cn('border-transparent text-foreground/70 hover:text-foreground', inkWashStates),
      },
    },
    defaultVariants: { orientation: 'vertical', current: false },
  },
);

/** The default link: the platform's own, for when there is no router in the way. */
function defaultRenderLink(props: NavLinkRenderProps): ReactElement {
  const { href, className, children } = props;

  return (
    <a href={href} className={className} aria-current={props['aria-current']}>
      {children}
    </a>
  );
}

export function Nav(props: NavProps): ReactNode {
  const {
    label,
    items,
    currentHref,
    orientation = 'vertical',
    renderLink = defaultRenderLink,
    className,
  } = props;

  return (
    <nav aria-label={label} className={className}>
      <ul className={navListVariants({ orientation })}>
        {items.map((item) => {
          const current = item.href === currentHref;
          const Glyph = item.icon;

          return (
            <li key={item.href}>
              {renderLink({
                href: item.href,
                className: navItemVariants({ orientation, current }),
                'aria-current': current ? 'page' : undefined,
                children: (
                  <>
                    {Glyph === undefined ? null : <Icon icon={Glyph} size="sm" />}
                    {item.label}
                  </>
                ),
              })}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
