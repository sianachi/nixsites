import { search, items as coreItems, isCanceledError } from '@nix/api-client';
import { Button, Field, Input, Select, Text } from '@nix/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { TreeItem } from '../items/use-workspace-tree';

interface ItemChoice {
  readonly id: string;
  readonly title: string;
}

/** Core-authorized searchable selector; loaded tree items are shortcuts, not the search boundary. */
export function TemplateItemPicker({
  label,
  hint,
  value,
  loadedItems,
  onChange,
  choiceLabel = 'Choose item',
  noneLabel = 'No item selected',
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly loadedItems: readonly TreeItem[];
  readonly onChange: (value: string | null) => void;
  /** Names the chooser; a page with several pickers gives each its own so no two share a name. */
  readonly choiceLabel?: string;
  /** What choosing nothing means here, such as "The whole workspace". */
  readonly noneLabel?: string;
}): ReactNode {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const [needle, setNeedle] = useState('');
  const [results, setResults] = useState<readonly ItemChoice[]>([]);
  const [selected, setSelected] = useState<ItemChoice | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [statusQuery, setStatusQuery] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [retry, setRetry] = useState(0);
  const query = needle.trim();
  const visibleResults = useMemo(
    () => (query.length >= 3 && statusQuery === query ? results : []),
    [query, results, statusQuery],
  );
  const visibleStatus = query.length < 3 ? 'idle' : statusQuery === query ? status : 'loading';
  const visibleTruncated = query.length < 3 ? false : truncated;
  const fromTree = useMemo(
    () => loadedItems.find((item) => item.id === value),
    [loadedItems, value],
  );
  const fromResults = useMemo(
    () => visibleResults.find((item) => item.id === value),
    [value, visibleResults],
  );
  const currentSelection = useMemo(
    () =>
      fromTree !== undefined
        ? { id: fromTree.id, title: fromTree.title }
        : (fromResults ?? (selected?.id === value ? selected : null)),
    [fromResults, fromTree, selected, value],
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const query = needle.trim();
    if (query.length < 3) {
      return () => {
        controller.abort();
      };
    }
    const timer = globalThis.setTimeout(() => {
      setStatus('loading');
      void client
        .query(search.searchItems(query, 50), { signal: controller.signal })
        .then((response) => {
          if (!active) return;
          setResults(
            response.results
              .filter((hit) => hit.workspaceId === workspaceId)
              .map((hit) => ({ id: hit.id, title: hit.title ?? 'Untitled' })),
          );
          setTruncated(response.truncated);
          setStatus('ready');
          setStatusQuery(query);
        })
        .catch((reason: unknown) => {
          if (!active || controller.signal.aborted || isCanceledError(reason)) return;
          setResults([]);
          setStatus('error');
          setStatusQuery(query);
        });
    }, 250);
    return () => {
      active = false;
      globalThis.clearTimeout(timer);
      controller.abort();
    };
  }, [client, needle, retry, workspaceId]);

  useEffect(() => {
    if (
      value.length === 0 ||
      fromTree !== undefined ||
      fromResults !== undefined ||
      selected?.id === value
    )
      return;
    const controller = new AbortController();
    void client
      .query(coreItems.itemById(value), { signal: controller.signal, forceRefresh: true })
      .then((item) => {
        if (controller.signal.aborted) return;
        setSelected({
          id: item.id,
          title: item.workspaceId === workspaceId ? item.title : 'An item in another workspace',
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isCanceledError(cause)) return;
        // Still the chosen value: say so rather than let the chooser fall back to "none".
        setSelected({ id: value, title: 'An item that could not be loaded' });
      });
    return () => {
      controller.abort();
    };
  }, [client, fromResults, fromTree, selected?.id, value, workspaceId]);

  const choices = useMemo(() => {
    const byId = new Map<string, ItemChoice>();
    for (const item of loadedItems) byId.set(item.id, { id: item.id, title: item.title });
    for (const item of visibleResults) byId.set(item.id, item);
    if (currentSelection !== null) byId.set(currentSelection.id, currentSelection);
    // A chosen item whose title has not arrived yet is still chosen; without an option for it the
    // select would show the first option and claim nothing was.
    else if (value.length > 0) byId.set(value, { id: value, title: 'Loading the chosen item…' });
    return [...byId.values()].sort((left, right) => left.title.localeCompare(right.title));
  }, [currentSelection, loadedItems, value, visibleResults]);

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} {...(hint === undefined ? {} : { hint })}>
        {(control) => (
          <Input
            {...control}
            type="search"
            value={needle}
            placeholder="Search accessible items"
            onChange={(event) => {
              setNeedle(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={choiceLabel}>
        {(control) => (
          <Select
            {...control}
            value={value}
            onChange={(event) => {
              onChange(event.target.value.length === 0 ? null : event.target.value);
            }}
          >
            <option value="">{noneLabel}</option>
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {visibleStatus === 'loading' ? (
        <Text as="p" role="status" variant="caption" tone="muted">
          Searching accessible items…
        </Text>
      ) : null}
      {visibleStatus === 'idle' && needle.trim().length > 0 ? (
        <Text variant="caption" tone="muted">
          Type at least three characters to search.
        </Text>
      ) : null}
      {visibleStatus === 'ready' && visibleResults.length === 0 ? (
        <Text as="p" role="status" variant="caption" tone="muted">
          {visibleTruncated
            ? 'Search results were capped before workspace filtering. Refine your search.'
            : 'No matching accessible items.'}
        </Text>
      ) : null}
      {visibleStatus === 'ready' && visibleResults.length > 0 && visibleTruncated ? (
        <Text as="p" role="status" variant="caption" tone="muted">
          More matches may exist. Refine your search.
        </Text>
      ) : null}
      {visibleStatus === 'error' ? (
        <div className="flex items-center gap-2">
          <Text as="p" role="alert" variant="caption">
            Item search failed.
          </Text>
          <Button
            variant="secondary"
            onClick={() => {
              setRetry((current) => current + 1);
            }}
          >
            Retry search
          </Button>
        </div>
      ) : null}
    </div>
  );
}
