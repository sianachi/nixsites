import { Button, Icon, Segmented, Text, cn, focusRing } from '@nix/ui';
import {
  Columns3,
  Globe,
  Info,
  Link2,
  ListTree,
  MessageSquare,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import { BacklinksPane } from '../links/backlinks-panel';
import { useItemComments } from '@nix/web-editor/editor/comment-anchors';
import { CommentsPane } from './comments-pane';
import { OutlinePane } from './outline-pane';
import { PropertyPanel } from '@nix/web-collections/properties/property-panel';
import { useSitesVisible } from '@nix/web-settings/settings/publishing/publishing-preference';
import { SitePane } from '@nix/web-sites/sites/site-pane';
import type { ItemProperties } from '@nix/web-collections/properties/use-item-properties';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { SchemaEditor } from '@nix/web-views/core/schema-editor';
import { ViewEditor } from '@nix/web-views/core/view-editor';

/**
 * One panel, six panes: what this item *is*, what its children may carry, how they are shown,
 * what elsewhere points at it, what people have said on it, and whether it is published as a site.
 *
 * **The rename is the point.** Two surfaces were called Properties - the values on this item, and
 * the schema it gives its children - and they are different questions with the same answer only by
 * accident. "Details" is what this one holds. "Fields" is what the things inside it may hold.
 *
 * Shown in a dialog on desktop and in the right-hand drawer on touch screens (`item-panels.tsx`).
 */

export type Pane = 'details' | 'fields' | 'views' | 'links' | 'outline' | 'comments' | 'site';

const PANES = [
  { value: 'details', label: 'Details' },
  { value: 'fields', label: 'Fields' },
  { value: 'views', label: 'Views' },
  // Last, and not first: what points *at* this item is a question people ask after the ones about
  // what it is. It sits here rather than in a surface of its own because it is another way of
  // configuring nothing and reading something, which is what this panel already is.
  { value: 'links', label: 'Backlinks' },
  // The headings of the open note, from the live editor document.
  { value: 'outline', label: 'Outline' },
  // The note's comment threads and suggestions.
  { value: 'comments', label: 'Comments' },
  // Publishing this item and everything inside it as a website (ADR-0063).
  { value: 'site', label: 'Site' },
] as const;

export interface ItemPanelProps {
  readonly container: ContainerData;

  /** This item's own property values, from `useItemProperties`. */
  readonly details: ItemProperties;

  /** Asked by the inline schema and view editors when they are done. */
  readonly onClose: () => void;

  /** The pane to show, when the caller steers it (the Site menu entry does). */
  readonly pane?: Pane;
  readonly onPaneChange?: (pane: Pane) => void;

  /** Phone right drawer: the pane switcher is an icon pill at the bottom, and there is no close row. */
  readonly drawer?: boolean;
}

const PANE_ICONS: Record<Pane, LucideIcon> = {
  details: Info,
  fields: SlidersHorizontal,
  views: Columns3,
  links: Link2,
  outline: ListTree,
  comments: MessageSquare,
  site: Globe,
};

export function ItemPanel({
  container,
  details,
  onClose,
  pane: steeredPane,
  onPaneChange,
  drawer = false,
}: ItemPanelProps): ReactNode {
  const sitesEnabled = useSitesVisible();
  const openComments = useItemComments(details.item?.id ?? null).threads.filter(
    (thread) => thread.resolvedAt === null,
  ).length;
  const [ownPane, setOwnPane] = useState<Pane>('details');
  const requestedPane = steeredPane ?? ownPane;
  // Comments are notes-only on the server; a canvas, sheet or file has no thread to show.
  const commentsAvailable = details.item?.type === 'note';
  // Switching publishing off while the Site pane is open falls back to Details.
  const pane =
    (requestedPane === 'site' && !sitesEnabled) ||
    (requestedPane === 'comments' && !commentsAvailable)
      ? 'details'
      : requestedPane;
  const setPane = onPaneChange ?? setOwnPane;
  const options = PANES.filter(
    (option) =>
      (sitesEnabled || option.value !== 'site') &&
      (commentsAvailable || option.value !== 'comments'),
  ).map((option) =>
    option.value === 'comments' && openComments > 0
      ? { ...option, label: `Comments (${String(openComments)})` }
      : option,
  );

  return (
    // The panel clips and the pane content inside it scrolls, rather than the panel itself
    // scrolling. With the scroller on the aside, the pane switcher and the only control that closes
    // the panel scrolled away with the fields - so on a container with a long schema you could edit
    // your way to a position with no visible way back. The workspace tree is built the same way,
    // for the same reason.
    <aside
      aria-label="Item settings"
      className={cn(
        'relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-surface',
        drawer && 'pt-[max(env(safe-area-inset-top),calc(var(--spacing)*3))]',
      )}
    >
      {drawer ? null : (
        <div className="flex shrink-0 items-center gap-2 px-3 py-3">
          <Segmented
            label="What to configure"
            options={options}
            value={pane}
            onChange={setPane}
            // One row: the seven tabs scroll sideways rather than wrapping onto a second line.
            className="min-w-0 flex-1 flex-nowrap overflow-x-auto bg-background *:shrink-0"
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
        {pane === 'details' ? (
          <DetailsPane container={container} details={details} />
        ) : pane === 'site' ? (
          details.item === null ? null : (
            <SitePane itemId={details.item.id} title={details.item.title} />
          )
        ) : pane === 'comments' ? (
          details.item === null ? null : (
            <CommentsPane itemId={details.item.id} />
          )
        ) : pane === 'outline' ? (
          <OutlinePane />
        ) : pane === 'links' ? (
          <BacklinksPane itemId={details.item?.id ?? null} />
        ) : pane === 'fields' ? (
          // Both editors render inline now rather than as modals. `open` stays in their contract
          // because it is what re-seeds their draft, and a pane that is not showing is closed as
          // far as they are concerned.
          <SchemaEditor container={container} open onClose={onClose} inline />
        ) : (
          <ViewEditor container={container} open onClose={onClose} inline />
        )}
      </div>

      {drawer ? (
        <div
          role="group"
          aria-label="What to configure"
          className="mx-auto mb-[max(env(safe-area-inset-bottom),var(--spacing))] flex shrink-0 items-center gap-1 rounded-full bg-foreground/7 p-1"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={option.label}
              aria-pressed={pane === option.value}
              onClick={() => {
                setPane(option.value);
              }}
              className={cn(
                `flex size-11 items-center justify-center rounded-full text-muted ${focusRing}`,
                pane === option.value && 'bg-accent-fill text-background',
              )}
            >
              <Icon icon={PANE_ICONS[option.value]} size="sm" />
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

/**
 * This item's own values.
 *
 * Says nothing rather than apologising when there is no schema: a panel reading "no properties" on
 * every note would be a permanent notice about a situation that is normal.
 */
function DetailsPane({
  container,
  details,
}: {
  readonly container: ContainerData;
  readonly details: ItemPanelProps['details'];
}): ReactNode {
  const properties = container.schema?.properties ?? [];

  if (details.error !== null) {
    return (
      <ErrorPanel
        title="This item's details could not be loaded"
        detail={details.error}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              details.retry();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  if (details.item === null) {
    return (
      <Text variant="note" tone="muted">
        Loading this item&rsquo;s details…
      </Text>
    );
  }

  if (!details.loading && properties.length === 0) {
    return (
      <Text variant="note" tone="muted">
        No details yet. Add fields to describe the items inside this one.
      </Text>
    );
  }

  return (
    <PropertyPanel
      key={details.item.id}
      compact
      item={details.item}
      properties={properties}
      loading={details.loading}
      onChange={details.write}
    />
  );
}
