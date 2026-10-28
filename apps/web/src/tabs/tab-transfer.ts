import { z } from 'zod';

import { PANE_LIMIT } from '@nix/web-platform/panes/pane-params';
import { closePaneParams, parsePanes } from '@nix/web-platform/panes/pane-state';
import { writeSelectedItem } from '@nix/web-platform/routing/selected-item';
import { ownerOfItem, tabsForPane } from './tab-ownership';
import { isChatTabId, type OpenTab } from '@nix/web-foundation/lib/tab-store';

export const TAB_TRANSFER_MIME = 'application/x-nix-document-tab';

const tabTransferPayloadSchema = z
  .object({
    version: z.literal(1),
    itemId: z.uuid(),
    sourcePane: z
      .number()
      .int()
      .min(0)
      .max(PANE_LIMIT - 1),
  })
  .strict();

export type TabTransferPayload = z.infer<typeof tabTransferPayloadSchema>;

/** Writes only Nix's private type so unrelated item and file drops cannot become tab moves. */
export function writeTabTransfer(dataTransfer: DataTransfer, payload: TabTransferPayload): void {
  dataTransfer.effectAllowed = 'move';
  dataTransfer.setData(TAB_TRANSFER_MIME, JSON.stringify(payload));
}

/** Parses the hostile drag boundary without allowing malformed JSON to escape into the UI. */
export function readTabTransfer(dataTransfer: DataTransfer): TabTransferPayload | null {
  if (!carriesTabTransfer(dataTransfer)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(TAB_TRANSFER_MIME));
    const result = tabTransferPayloadSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    console.warn('Ignoring malformed Nix tab transfer payload.', result.error);
    return null;
  } catch {
    console.warn('Ignoring malformed Nix tab transfer payload.');
    return null;
  }
}

export function carriesTabTransfer(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(TAB_TRANSFER_MIME);
}

export type TabTransferRefusal = 'same-pane' | 'hidden-pane' | 'missing-pane' | 'stale-tab';

export interface TabTransferPlan {
  readonly nextParams: URLSearchParams;
  readonly nextByPane: Readonly<Record<number, readonly OpenTab[]>>;
  readonly finalDestinationPane: number;
  readonly sourceClosed: boolean;
}

export interface PlanTabTransferInput {
  readonly params: URLSearchParams;
  readonly byPane: Readonly<Record<number, readonly OpenTab[]>>;
  readonly visiblePaneIndexes: readonly number[];
  readonly payload: TabTransferPayload;
  readonly destinationPane: number;
}

export type PlanTabTransferResult =
  | { readonly plan: TabTransferPlan; readonly refusal: null }
  | { readonly plan: null; readonly refusal: TabTransferRefusal };

function withoutItem(
  byPane: Readonly<Record<number, readonly OpenTab[]>>,
  itemId: string,
): Record<number, readonly OpenTab[]> {
  const next: Record<number, readonly OpenTab[]> = {};
  for (const [key, tabs] of Object.entries(byPane)) {
    next[Number(key)] = tabs.filter((tab) => tab.itemId !== itemId);
  }
  return next;
}

function compactClosedPane(
  byPane: Readonly<Record<number, readonly OpenTab[]>>,
  closed: number,
  count: number,
): Readonly<Record<number, readonly OpenTab[]>> {
  const compacted: Record<number, readonly OpenTab[]> = {};
  for (const [key, tabs] of Object.entries(byPane)) {
    const from = Number(key);
    if (from === closed) {
      continue;
    }
    const to = from > closed && from < count ? from - 1 : from;
    compacted[to] = tabs;
  }
  return compacted;
}

/**
 * Plans the URL and session-state halves of one cross-pane move as a single result.
 *
 * The active URL document is materialized into both strips first. This is what keeps a fresh link,
 * whose tab store is empty, from losing the source replacement or destination's previous active
 * tab. The moved tab is pinned because choosing a destination is the same deliberate commitment
 * as opening beside; the destination's existing preview therefore survives.
 */
export function planTabTransfer(input: PlanTabTransferInput): PlanTabTransferResult {
  const { params, byPane, visiblePaneIndexes, payload, destinationPane } = input;
  const { sourcePane, itemId } = payload;

  if (sourcePane === destinationPane) {
    return { plan: null, refusal: 'same-pane' };
  }
  if (!visiblePaneIndexes.includes(sourcePane) || !visiblePaneIndexes.includes(destinationPane)) {
    return { plan: null, refusal: 'hidden-pane' };
  }

  const arrangement = parsePanes(params);
  const source = arrangement.panes.find((pane) => pane.index === sourcePane);
  const destination = arrangement.panes.find((pane) => pane.index === destinationPane);
  if (source === undefined || destination === undefined) {
    return { plan: null, refusal: 'missing-pane' };
  }

  if (ownerOfItem(itemId, arrangement.panes, byPane) !== sourcePane) {
    return { plan: null, refusal: 'stale-tab' };
  }

  const sourceTabs = tabsForPane(sourcePane, source.itemId, arrangement.panes, byPane);
  // Chat tabs ride along in the strips but are never a pane's replacement document.
  const movedIndex = sourceTabs
    .filter((tab) => !isChatTabId(tab.itemId))
    .findIndex((tab) => tab.itemId === itemId);
  if (movedIndex === -1) {
    return { plan: null, refusal: 'stale-tab' };
  }

  const destinationTabs = tabsForPane(
    destinationPane,
    destination.itemId,
    arrangement.panes,
    byPane,
  );
  const remaining = sourceTabs.filter((tab) => tab.itemId !== itemId);
  const remainingItems = remaining.filter((tab) => !isChatTabId(tab.itemId));
  const sourceClosed = source.itemId === itemId && remainingItems.length === 0;
  const finalDestinationPane =
    sourceClosed && destinationPane > sourcePane ? destinationPane - 1 : destinationPane;

  const nextParams = new URLSearchParams(params);
  if (sourceClosed) {
    closePaneParams(nextParams, sourcePane, arrangement.panes.length);
    writeSelectedItem(nextParams, finalDestinationPane, itemId);
  } else {
    if (source.itemId === itemId) {
      const neighbor = remainingItems[Math.max(0, movedIndex - 1)];
      if (neighbor === undefined) {
        return { plan: null, refusal: 'stale-tab' };
      }
      writeSelectedItem(nextParams, sourcePane, neighbor.itemId);
    }
    writeSelectedItem(nextParams, destinationPane, itemId);
  }

  const installed = withoutItem(byPane, itemId);
  // Every addressed pane may be URL-only on a fresh link. Materialize all of them before a close
  // compacts indices, or an untouched middle pane has no store entry to shift and disappears from
  // the working set even though its address survived correctly.
  for (const pane of arrangement.panes) {
    installed[pane.index] = tabsForPane(pane.index, pane.itemId, arrangement.panes, byPane).filter(
      (tab) => tab.itemId !== itemId,
    );
  }
  installed[sourcePane] = remaining;
  installed[destinationPane] = [
    ...destinationTabs.filter((tab) => tab.itemId !== itemId),
    { itemId, pinned: true },
  ];

  return {
    plan: {
      nextParams,
      nextByPane: sourceClosed
        ? compactClosedPane(installed, sourcePane, arrangement.panes.length)
        : installed,
      finalDestinationPane,
      sourceClosed,
    },
    refusal: null,
  };
}
