import { Button, ContextMenu, focusRing, Input, Text } from '@nix/ui';
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { CanvasElement } from './canvas-binding';
import {
  itemIdFromNixLink,
  nixFileItemIdFromElement,
  nixItemIdFromElement,
  prepareCanvasElements,
} from './nix-canvas-model';

export function canvasEntries(elements: readonly CanvasElement[]): {
  entries: { id: string; title: string; itemId: string | null; kind: string }[];
  drawingCount: number;
} {
  const scene = prepareCanvasElements(elements).filter((element) => !element.isDeleted);
  const byId = new Map(scene.map((element) => [element.id, element]));
  const entries: { id: string; title: string; itemId: string | null; kind: string }[] = [];
  let drawingCount = 0;
  for (const element of scene) {
    const itemId =
      nixItemIdFromElement(element) ??
      nixFileItemIdFromElement(element) ??
      itemIdFromNixLink(element.link);
    const label = element.boundElements
      ?.map((bound) => byId.get(bound.id))
      .find((bound) => bound?.type === 'text');
    if (itemId) {
      entries.push({
        id: element.id,
        title:
          label?.type === 'text'
            ? label.text
            : element.type === 'text'
              ? element.text
              : 'Linked item',
        itemId,
        kind: element.type === 'image' ? 'Image' : 'Item',
      });
    } else if (element.type === 'text') {
      const container = element.containerId ? byId.get(element.containerId) : null;
      if (container && (nixItemIdFromElement(container) || itemIdFromNixLink(container.link)))
        continue;
      entries.push({ id: element.id, title: element.text, itemId: null, kind: 'Text' });
    } else if (element.type === 'image') {
      entries.push({ id: element.id, title: 'Canvas image', itemId: null, kind: 'Image' });
    } else {
      drawingCount += 1;
    }
  }
  return { entries, drawingCount };
}

export function CanvasBrowser({
  elements,
  onOpen,
  onSpatial,
  loading,
}: {
  readonly elements: readonly CanvasElement[];
  readonly onOpen: (itemId: string) => void;
  readonly onSpatial: () => void;
  readonly loading: boolean;
}): ReactNode {
  const [search, setSearch] = useState('');
  const searchId = useId();
  // Scene conversion walks every shape; searching must not repeat it for unchanged scene data.
  const { entries, drawingCount } = useMemo(() => canvasEntries(elements), [elements]);
  const visible = entries.filter((entry) =>
    entry.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <section aria-label="Canvas contents" className="h-full min-w-0 overflow-y-auto px-4 py-3">
      <label htmlFor={searchId} className="flex min-w-0 flex-col gap-2">
        <Text as="span" variant="caption">
          Find in canvas
        </Text>
        <Input
          id={searchId}
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </label>
      {loading && elements.length === 0 ? (
        <Text as="p" className="py-4">
          Loading canvas…
        </Text>
      ) : null}
      {!loading && entries.length === 0 && drawingCount === 0 ? (
        <Text as="p" className="py-4">
          Your canvas is empty. Open the spatial canvas to add something.
        </Text>
      ) : null}
      {search && visible.length === 0 ? (
        <Text as="p" className="py-4">
          No matching content.
        </Text>
      ) : null}
      <ul className="divide-y divide-divider">
        {visible.map((entry) => (
          <ContextMenu
            key={entry.id}
            label="Canvas content actions"
            items={[
              ...(entry.itemId === null
                ? []
                : [
                    {
                      label: 'Open item',
                      onSelect: () => {
                        if (entry.itemId !== null) onOpen(entry.itemId);
                      },
                    },
                  ]),
              { label: 'Show spatial canvas', onSelect: onSpatial },
            ]}
          >
            {(target) => (
              <li
                {...target}
                tabIndex={entry.itemId === null && entry.kind === 'Text' ? 0 : undefined}
                className={`min-w-0 py-4 ${focusRing}`}
              >
                <Text as="p" variant="caption" tone="muted">
                  {entry.kind}
                </Text>
                {entry.itemId !== null ? (
                  <Button
                    variant="ghost"
                    className="h-auto min-h-(--control-md) w-full justify-start whitespace-normal py-2 text-left any-pointer-coarse:h-auto any-pointer-coarse:min-h-(--control-lg)"
                    onClick={() => {
                      if (entry.itemId) onOpen(entry.itemId);
                    }}
                  >
                    <Text as="span" className="min-w-0 [overflow-wrap:anywhere]">
                      {entry.title || 'Untitled'}
                    </Text>
                  </Button>
                ) : entry.kind === 'Image' ? (
                  <Button variant="ghost" className="max-w-full" onClick={onSpatial}>
                    View image in canvas
                  </Button>
                ) : (
                  <Text as="p" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {entry.title}
                  </Text>
                )}
              </li>
            )}
          </ContextMenu>
        ))}
      </ul>
      {drawingCount > 0 ? (
        <Button variant="secondary" className="max-w-full" onClick={onSpatial}>
          View drawing ({String(drawingCount)} shapes)
        </Button>
      ) : null}
    </section>
  );
}
