import { Button, Icon, Segmented, Text, cn, focusRing } from '@nix/ui';
import { PanelRightClose } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import { settingsPanelWidth } from '@nix/web-foundation/layout/regions';
import { BacklinksPane } from '../links/backlinks-panel';
import { useItemComments } from '@nix/web-editor/editor/comment-anchors';
import { CommentsPane } from './comments-pane';
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
 * It replaces two ghost buttons that opened modals. A dialog is the wrong shape for configuring a
 * view: it covers the view you are configuring, so every change means closing it to look and
 * reopening it to continue.
 */

export type Pane = 'details' | 'fields' | 'views' | 'links' | 'comments' | 'site';

const PANES = [
  { value: 'details', label: 'Details' },
  { value: 'fields', label: 'Fields' },
  { value: 'views', label: 'Views' },
  // Last, and not first: what points *at* this item is a question people ask after the ones about
  // what it is. It sits here rather than in a surface of its own because it is another way of
  // configuring nothing and reading something, which is what this panel already is.
  { value: 'links', label: 'Links' },
  // The note's comment threads and suggestions.
  { value: 'comments', label: 'Comments' },
  // Publishing this item and everything inside it as a website (ADR-0063).
  { value: 'site', label: 'Site' },
] as const;

export interface ItemPanelProps {
  readonly container: ContainerData;

  /** This item's own property values, from `useItemProperties`. */
  readonly details: ItemProperties;

  readonly onClose: () => void;
  readonly overlay?: boolean;

  /** The pane to show, when the caller steers it (the Site menu entry does). */
  readonly pane?: Pane;
  readonly onPaneChange?: (pane: Pane) => void;
}

export function ItemPanel({
  container,
  details,
  onClose,
  overlay = false,
  pane: steeredPane,
  onPaneChange,
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

  return (
    // The panel clips and the pane content inside it scrolls, rather than the panel itself
    // scrolling. With the scroller on the aside, the pane switcher and the only control that closes
    // the panel scrolled away with the fields - so on a container with a long schema you could edit
    // your way to a position with no visible way back. The workspace tree is built the same way,
    // for the same reason.
    <aside
      aria-label="Item settings"
      className={cn(
        'flex shrink-0 flex-col overflow-hidden bg-surface',
        settingsPanelWidth,
        overlay && 'min-h-0 w-full flex-1 shrink',
      )}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-3">
        <Segmented
          label="What to configure"
          options={PANES.filter(
            (option) =>
              (sitesEnabled || option.value !== 'site') &&
              (commentsAvailable || option.value !== 'comments'),
          ).map((option) =>
            option.value === 'comments' && openComments > 0
              ? { ...option, label: `Comments (${String(openComments)})` }
              : option,
          )}
          value={pane}
          onChange={setPane}
          className="min-w-0 flex-1"
        />

        {/* In a dialog the dialog's own close is the one way out; a second would be a duplicate. */}
        {overlay ? null : (
          <button
            type="button"
            aria-label="Hide the settings panel"
            onClick={onClose}
            className={`flex size-7 max-xl:min-h-11 max-xl:min-w-11 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-foreground/7 hover:text-foreground ${focusRing}`}
          >
            <Icon icon={PanelRightClose} size="sm" />
          </button>
        )}
      </div>

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
