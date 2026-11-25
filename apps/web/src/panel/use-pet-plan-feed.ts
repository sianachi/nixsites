import {
  isNixApiError,
  petPlans,
  type NixClient,
  type PetPlanList,
  type PetPlanResponse,
} from '@nix/api-client';
import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { useEffect, useState } from 'react';

type Feed =
  | { readonly status: 'loading' | 'unavailable' | 'error' }
  | { readonly status: 'ready'; readonly data: PetPlanList; readonly refreshFailed?: boolean };

interface PetPlanFeed {
  readonly client: NixClient | null;
  readonly feed: Feed;
  readonly update: (run: PetPlanResponse) => void;
  readonly retry: () => void;
}

export function usePetPlanFeed(
  workspaceId: string,
  enabled = true,
  activeRunId?: string,
): PetPlanFeed {
  const client = useOptionalApiClient();
  const [snapshot, setSnapshot] = useState<{ readonly key: string; readonly feed: Feed } | null>(
    null,
  );
  const [reload, setReload] = useState(0);
  const key = `${workspaceId}:${activeRunId ?? ''}`;
  const feed: Feed =
    enabled && client !== null
      ? snapshot?.key === key
        ? snapshot.feed
        : { status: 'loading' }
      : { status: 'unavailable' };
  useEffect(() => {
    if (!enabled || client === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(): Promise<void> {
      if (client === null) return;
      try {
        let data = await client.query(petPlans.list(workspaceId), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (activeRunId !== undefined && !data.runs.some((run) => run.id === activeRunId)) {
          try {
            const run = await client.query(petPlans.getRun(workspaceId, activeRunId), {
              signal: controller.signal,
              forceRefresh: true,
            });
            data = { ...data, runs: [...data.runs, run] };
          } catch (reason) {
            if (controller.signal.aborted) return;
            if (!isNixApiError(reason) || (reason.status !== 403 && reason.status !== 404))
              throw reason;
          }
        }
        if (controller.signal.aborted) return;
        setSnapshot((current) => ({
          key,
          feed: {
            status: 'ready',
            data: {
              ...data,
              runs: data.runs.map((run) =>
                current?.key === key && current.feed.status === 'ready'
                  ? (current.feed.data.runs.find(
                      (shown) => shown.id === run.id && shown.revision > run.revision,
                    ) ?? run)
                  : run,
              ),
            },
          },
        }));
      } catch (reason) {
        if (controller.signal.aborted) return;
        setSnapshot((current) => ({
          key,
          feed:
            isNixApiError(reason) && (reason.status === 404 || reason.status === 403)
              ? { status: 'unavailable' }
              : current?.key === key && current.feed.status === 'ready'
                ? { ...current.feed, refreshFailed: true }
                : { status: 'error' },
        }));
      }
      timer = setTimeout(() => void load(), 4_000);
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, enabled, key, workspaceId, activeRunId, reload]);

  function update(run: PetPlanResponse): void {
    setSnapshot((current) => {
      if (current?.key !== key || current.feed.status !== 'ready') return current;
      const existing = current.feed.data.runs.find((shown) => shown.id === run.id);
      if (existing !== undefined && existing.revision > run.revision) return current;
      return {
        key,
        feed: {
          ...current.feed,
          data: {
            ...current.feed.data,
            runs:
              existing === undefined
                ? [...current.feed.data.runs, run]
                : current.feed.data.runs.map((shown) => (shown.id === run.id ? run : shown)),
          },
        },
      };
    });
  }
  return {
    client,
    feed,
    update,
    retry: () => {
      setReload((current) => current + 1);
    },
  };
}
