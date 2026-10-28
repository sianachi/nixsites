import { items, type Item } from '@nix/api-client';
import { useEffect, useState } from 'react';

import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { useOptionalWorkspace } from '../workspaces/workspace-context';
import type { PropertyDefinition } from '../views/core/container-model';

/** Only scalar text and text choices contribute; objects never become suggestion labels. */
export function fieldChoices(
  rows: readonly Pick<Item, 'title' | 'properties'>[],
  field: string,
): string[] {
  const values = rows.flatMap((row) => {
    const value: unknown = field === 'title' ? row.title : row.properties[field];
    return Array.isArray(value)
      ? value.filter((entry: unknown): entry is string => typeof entry === 'string')
      : typeof value === 'string'
        ? [value]
        : [];
  });
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  ];
}

export function useFieldChoices(
  property: PropertyDefinition,
  parentId: string | null | undefined,
  enabled: boolean,
): { values: readonly string[]; hint: string } {
  const client = useOptionalApiClient();
  const workspaceId = useOptionalWorkspace()?.workspaceId;
  const sourceId = property.choiceSource?.itemId ?? parentId;
  const field = property.choiceSource?.field;
  const learnsOwnValues = !property.choiceSource?.itemId && field === property.key;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; values: string[]; hint: string } | null>(
    null,
  );
  const key = `${workspaceId ?? ''}/${sourceId ?? ''}/${field ?? ''}/${String(revision)}`;

  useEffect(() => {
    if (!enabled || !client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = client.cache.subscribeInvalidation((prefix) => {
      if (prefix.length === 0 || prefix[0] === 'items' || prefix[0] === 'workspaces') {
        clearTimeout(timer);
        timer = setTimeout(() => {
          setRevision((value) => value + 1);
        }, 150);
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [client, enabled]);

  useEffect(() => {
    if (!enabled || !client || !workspaceId || !sourceId || !field) return;
    const controller = new AbortController();
    void (async () => {
      const rows: Item[] = [];
      let truncated = false;
      try {
        for await (const row of client.paginate(
          items.listItems(workspaceId, { parentId: sourceId, pageSize: 200 }),
          { signal: controller.signal, forceRefresh: true },
        )) {
          if (rows.length === 500) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        if (!controller.signal.aborted)
          setResult({
            key,
            values: learnsOwnValues && rows.length < 2 ? [] : fieldChoices(rows, field),
            hint: truncated
              ? 'Suggestions use the first 500 visible entries. You can also enter a value.'
              : learnsOwnValues && rows.length < 2
                ? 'Suggestions appear after two saved entries. You can enter a value now.'
                : rows.length === 0
                  ? 'No saved values yet. Enter a value to get started.'
                  : 'Choose a saved value or enter a new one.',
          });
      } catch {
        if (!controller.signal.aborted)
          setResult({
            key,
            values: [],
            hint: 'Suggestions could not be loaded. You can still enter a value.',
          });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [client, workspaceId, sourceId, field, key, enabled, learnsOwnValues]);

  if (!enabled)
    return result?.key === key
      ? result
      : { values: [], hint: 'Suggestions come from saved entries. You can also enter a value.' };
  if (!client || !workspaceId || !sourceId || !field)
    return {
      values: [],
      hint: 'The suggestion source is unavailable. You can still enter a value.',
    };
  return result?.key === key ? result : { values: [], hint: 'Loading suggestions.' };
}
