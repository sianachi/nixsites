import {
  isCanceledError,
  isNixApiError,
  items as coreItems,
  structure as coreStructure,
  type NixClient,
} from '@nix/api-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  cacheKeysOverlap,
  useCacheInvalidation,
} from '@nix/web-platform/api/use-cache-invalidation';
import { decorateItem, keepComputed } from './computed';
import {
  EffectiveSchemaSchema,
  ItemSchema,
  type EffectiveSchema,
  type Item,
} from '../core/container-model';

/**
 * One item's schema and the means to write its properties.
 *
 * Separate from `useContainer`, which loads a folder and everything in it. A note needs its own
 * effective schema and nothing else, and loading a folder's children to show one note's properties
 * would be a page of rows fetched to render a panel.
 *
 * **The schema is resolved at the item, not at its parent.** An item's own declaration is part of
 * what its values are checked against, and asking at the parent would miss it - the same
 * distinction the resolver draws between resolving for an item and resolving for its children.
 */

export interface ItemProperties {
  readonly loading: boolean;
  readonly schema: EffectiveSchema | null;

  /**
   * The item, with its property values.
   *
   * Fetched here rather than taken from the tree, which carries a narrower shape - it was built
   * before properties existed and knows nothing about them. Reaching into it for a value it does
   * not hold would be a cast that compiles and reads undefined.
   */
  readonly item: Item | null;

  /**
   * Why the load failed, or null when it has not failed.
   *
   * Distinct from `item` being null: that is also true while the load is still in flight, and a
   * panel that could not tell those two apart would say "Loading" forever about a request that
   * already came back refused.
   */
  readonly error: string | null;

  /** Retries the load that failed, from scratch. */
  readonly retry: () => void;

  /** Writes the changed properties, answering with the refusal reason or null. */
  readonly write: (changes: Record<string, unknown>) => Promise<string | null>;
}

export function useItemProperties(itemId: string | null): ItemProperties {
  const client = useApiClient();

  const [loading, setLoading] = useState(true);
  const [schema, setSchema] = useState<EffectiveSchema | null>(null);
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedItem = useRef<{ readonly client: NixClient; readonly itemId: string } | null>(null);
  const accessRevision = useRef(0);

  // A retry or invalidation refreshes the same item without replacing its mounted controls.
  const [attempt, setAttempt] = useState(0);

  useCacheInvalidation(
    (prefix) =>
      itemId !== null &&
      (prefix[0] === 'items' ||
        (item !== null && cacheKeysOverlap(prefix, ['workspaces', item.workspaceId, 'items']))),
    () => {
      setAttempt((current) => current + 1);
    },
  );

  useEffect(() => {
    // A box rather than a bare flag: the cleanup writes it and the async body reads it, and a
    // narrowed boolean would let the compiler decide the second check is dead when it is the one
    // that matters.
    const live = { current: true };
    const controller = new AbortController();

    // queueMicrotask so the first setState lands after the effect returns rather than during it,
    // which is what stops the initial render cascading. The same reason the tree does it.
    queueMicrotask(() => {
      if (!live.current) {
        return;
      }

      if (itemId === null) {
        loadedItem.current = null;
        setSchema(null);
        setItem(null);
        setError(null);
        setLoading(false);
        return;
      }

      const background =
        loadedItem.current?.client === client && loadedItem.current.itemId === itemId;
      setLoading(!background);
      setError(null);
      const refuse = (message: string): void => {
        if (!live.current || controller.signal.aborted) return;
        accessRevision.current += 1;
        loadedItem.current = null;
        setSchema(null);
        setItem(null);
        setError(message);
        setLoading(false);
        controller.abort();
      };
      void (async () => {
        // Both at once: the panel cannot draw a field without knowing the property exists, and
        // cannot fill it without the value. Sequencing them would make opening a note two round
        // trips deep for one panel.
        //
        // An initial item failure is shown to the reader. A transient background failure retains
        // authorized values being edited; a confirmed item or schema refusal removes them.
        const [nextSchema, itemOutcome] = await Promise.all([
          queryOutcome(
            client.query(coreStructure.effectiveSchema(itemId), {
              signal: controller.signal,
              forceRefresh: true,
            }),
            refuse,
          ),
          queryOutcome(
            client.query(coreItems.itemById(itemId), {
              signal: controller.signal,
              forceRefresh: true,
            }),
            refuse,
          ),
        ]);

        // Dropped if the item changed while this was in flight. Without the guard, opening two
        // notes quickly could paint the first one's schema over the second's - a panel offering
        // properties that do not apply to what is on screen.
        if (!live.current || controller.signal.aborted) {
          return;
        }

        if (itemOutcome.ok) {
          if (nextSchema.ok) setSchema(EffectiveSchemaSchema.parse(nextSchema.value));
          else if (!background) setSchema(null);
          loadedItem.current = { client, itemId };
          setItem(ItemSchema.parse(itemOutcome.value));
          setError(null);
        } else if (!background) {
          loadedItem.current = null;
          setSchema(null);
          setItem(null);
          setError(itemOutcome.message);
        }

        setLoading(false);
      })().catch((reason: unknown) => {
        if (!controller.signal.aborted && live.current && !isCanceledError(reason)) {
          if (!background) {
            loadedItem.current = null;
            setSchema(null);
            setItem(null);
            setError('This item could not be loaded.');
          }
          setLoading(false);
        }
      });
    });

    return () => {
      live.current = false;
      controller.abort();
    };
  }, [client, itemId, attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const write = useCallback(
    async (changes: Record<string, unknown>): Promise<string | null> => {
      if (itemId === null) {
        return 'There is nothing open to write to.';
      }
      const revision = accessRevision.current;

      try {
        // The response carries the item as it now stands, so the panel reflects what was stored
        // rather than what was typed - which is the difference that shows when the server normalised
        // something on the way in.
        const written = ItemSchema.parse(
          await client.execute(coreStructure.setItemProperties(itemId, changes)),
        );
        if (revision !== accessRevision.current) return null;
        // The write answers with the item and not with a fresh fold of its children, so the
        // rollups come back null; keeping the last folded values is more honest than blanking the
        // panel's rollup rows on every edit.
        setItem((previous) => keepComputed(previous ?? undefined, written));
      } catch (reason) {
        return isNixApiError(reason)
          ? (reason.detail ?? 'That change could not be saved.')
          : 'That change could not be saved.';
      }

      return null;
    },
    [client, itemId],
  );

  /**
   * The item as the panel reads it: what the server sent, plus the properties this build computes.
   *
   * Derived rather than merged into state, so `write` keeps sending only the keys somebody edited
   * and a computed value can never be posted back as a stored one. Memoised for identity: the
   * panel's controls take this object as a prop, and `useDraft` compares the value it reads off it
   * against what it last sent - a fresh object each render is a fresh prop, which is the identity
   * that comparison hangs on.
   */
  const computed = useMemo(
    () => (item === null ? null : decorateItem(item, schema?.properties)),
    [item, schema?.properties],
  );

  return { loading, schema, item: computed, error, retry, write };
}

type QueryOutcome<TValue> =
  { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly message: string };

/** Reads a response the panel cannot do without, keeping the refusal reason rather than folding it away. */
async function queryOutcome<TValue>(
  request: Promise<TValue>,
  refuse: (message: string) => void,
): Promise<QueryOutcome<TValue>> {
  try {
    return { ok: true, value: await request };
  } catch (reason) {
    if (isCanceledError(reason)) {
      throw reason;
    }
    const message = isNixApiError(reason)
      ? (reason.detail ?? 'This item could not be loaded.')
      : 'This item could not be loaded.';
    if (
      isNixApiError(reason) &&
      (reason.status === 403 || reason.status === 404 || reason.status === 423)
    )
      refuse(message);
    return { ok: false, message };
  }
}
