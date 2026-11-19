import {
  isNixApiError,
  petRuns,
  type NixClient,
  type PetRunList,
  type PetRunResponse,
} from '@nix/api-client';
import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { z } from 'zod';

type Feed =
  | { readonly status: 'loading' | 'unavailable' | 'error' }
  | {
      readonly status: 'ready';
      readonly data: PetRunList;
      readonly refreshFailed?: boolean;
      readonly activeRunUnavailable?: boolean;
    };

const pollMs = 4_000;
const loading = { status: 'loading' } as const;
const renamePreview = z.object({
  operationId: z.literal('UpdateItem'),
  inputs: z.object({ path: z.object({ itemId: z.uuid() }) }),
});

interface PetRunFeed {
  readonly client: NixClient | null;
  readonly feed: Feed;
  readonly update: (run: PetRunResponse) => void;
  readonly retry: () => void;
}

export function usePetRunFeed(
  scope: 'item' | 'workspace',
  id: string,
  activeRunId?: string,
  onItemChanged?: (itemId: string) => void,
): PetRunFeed {
  const client = useOptionalApiClient();
  const [snapshot, setSnapshot] = useState<{
    readonly client: NixClient;
    readonly key: string;
    readonly feed: Feed;
  } | null>(null);
  const [reload, setReload] = useState(0);
  const key = `${scope}:${id}:${activeRunId ?? ''}`;
  const feed = snapshot?.client === client && snapshot.key === key ? snapshot.feed : loading;
  const observed = useRef<{ client: NixClient; key: string; data: PetRunList } | null>(null);
  const reportItemChanged = useEffectEvent((itemId: string) => {
    onItemChanged?.(itemId);
  });

  useEffect(() => {
    if (client === null || scope !== 'item' || feed.status !== 'ready') return;
    const previous = observed.current;
    observed.current = { client, key, data: feed.data };
    if (previous?.client !== client || previous.key !== key) return;

    const priorSteps = new Map(
      previous.data.runs.flatMap((run) =>
        run.proposals.map((proposal) => [proposal.id, proposal.status] as const),
      ),
    );
    const changedItems = new Set<string>();
    for (const run of feed.data.runs) {
      for (const proposal of run.proposals) {
        if (
          (proposal.status !== 'applied' && proposal.status !== 'undone') ||
          proposal.status === priorSteps.get(proposal.id)
        )
          continue;
        if (proposal.capability === 'task.rename') changedItems.add(run.itemId);
        if (proposal.capability === 'nix.action') {
          const preview = renamePreview.safeParse(proposal.preview);
          if (preview.success) changedItems.add(preview.data.inputs.path.itemId);
        }
      }
    }
    for (const itemId of changedItems) reportItemChanged(itemId);
  }, [client, feed, key, scope]);

  useEffect(() => {
    if (client === null) return;
    const controller = new AbortController();
    const endpoint = scope === 'item' ? petRuns.listForItem(id) : petRuns.listForWorkspace(id);
    let timer: ReturnType<typeof setTimeout> | undefined;

    function setFeed(update: (current: Feed) => Feed) {
      if (client === null || controller.signal.aborted) return;
      setSnapshot((current) => ({
        client,
        key,
        feed: update(current?.client === client && current.key === key ? current.feed : loading),
      }));
    }

    function schedule(delay: number) {
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), delay);
    }

    async function load(): Promise<void> {
      if (client === null) return;
      if (document.hidden) {
        schedule(pollMs);
        return;
      }
      try {
        let data = await client.query(endpoint, {
          signal: controller.signal,
          forceRefresh: true,
        });
        let activeRunUnavailable = false;
        if (
          scope === 'item' &&
          activeRunId !== undefined &&
          !data.runs.some((run) => run.id === activeRunId)
        ) {
          try {
            const activeRun = await client.query(petRuns.getRun(id, activeRunId), {
              signal: controller.signal,
              forceRefresh: true,
            });
            data = { ...data, runs: [...data.runs, activeRun] };
          } catch (error) {
            if (controller.signal.aborted) return;
            if (!isNixApiError(error) || (error.status !== 403 && error.status !== 404))
              throw error;
            activeRunUnavailable = true;
          }
        }
        if (controller.signal.aborted) return;
        setFeed((current) => ({
          status: 'ready',
          activeRunUnavailable,
          data:
            current.status === 'ready'
              ? {
                  ...data,
                  runs: data.runs.map(
                    (run) =>
                      current.data.runs.find(
                        (shown) => shown.id === run.id && shown.revision > run.revision,
                      ) ?? run,
                  ),
                }
              : data,
        }));
        if (data.enabled) schedule(pollMs);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (isNixApiError(error) && (error.status === 403 || error.status === 404)) {
          setFeed(() => ({ status: 'unavailable' }));
          return;
        }
        setFeed((current) =>
          current.status === 'ready' ? { ...current, refreshFailed: true } : { status: 'error' },
        );
        schedule(
          Math.max(pollMs, isNixApiError(error) ? (error.retryAfterSeconds ?? 0) * 1_000 : 0),
        );
      }
    }

    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, scope, id, key, reload, activeRunId]);

  function update(run: PetRunResponse): void {
    setSnapshot((previous) => {
      if (previous?.client !== client || previous.key !== key) return previous;
      const current = previous.feed;
      if (current.status !== 'ready') return previous;
      const same = current.data.runs.find((shown) => shown.id === run.id);
      if (same !== undefined && same.revision > run.revision) return previous;
      const runs =
        same === undefined
          ? [run, ...current.data.runs]
          : current.data.runs.map((shown) => (shown.id === run.id ? run : shown));
      return { ...previous, feed: { ...current, data: { ...current.data, runs } } };
    });
    setReload((current) => current + 1);
  }

  return {
    client,
    feed: client === null ? ({ status: 'unavailable' } as const) : feed,
    update,
    retry: () => {
      setReload((current) => current + 1);
    },
  };
}
