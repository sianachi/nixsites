import {
  isCanceledError,
  isNixApiError,
  items as coreItems,
  recurrence as coreRecurrence,
  structure as coreStructure,
  views as coreViews,
  workspaceCalendar as coreWorkspaceCalendar,
  type WorkspaceCalendar,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { addEndTimes as addEndTimesTo } from '../views/calendar/add-end-times';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '../workspaces/workspace-context';
import { onItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';

export type CalendarStatus = 'loading' | 'ready' | 'error';

export interface WorkspaceCalendarState {
  readonly status: CalendarStatus;
  readonly calendar: WorkspaceCalendar | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  readonly reschedule: (itemId: string, dateProperty: string, value: string) => Promise<boolean>;

  /** Writes several of an item's properties at once - a start and its end together. */
  readonly write: (itemId: string, values: Record<string, string | null>) => Promise<boolean>;

  /**
   * Gives one container's calendar an end property, then reloads. Resolves to why it could not,
   * or null when it did.
   */
  readonly addEndTimes: (containerId: string) => Promise<string | null>;
  readonly create: (containerId: string, title: string, day: string) => Promise<string | null>;

  /** Marks one day of a repeating item's series done, then reloads the window it changed. */
  readonly complete: (itemId: string, occurredOn: string) => Promise<boolean>;
}

function calendarError(reason: unknown): string {
  if (isNixApiError(reason) && reason.code === 'workspaces.not_found') {
    return 'This workspace could not be found.';
  }
  if (isNixApiError(reason) && reason.code === 'calendar.invalid_window') {
    return 'This version of the application asked for a range the server refused.';
  }
  if (isNixApiError(reason) && reason.status === 404) {
    return 'This version of the application asked for a calendar the server does not offer. The server may be running an older build.';
  }
  return 'The calendar could not be loaded.';
}

function requestReason(reason: unknown, fallback: string): string {
  return isNixApiError(reason) ? (reason.detail ?? fallback) : fallback;
}

export function useWorkspaceCalendar(from: string, to: string): WorkspaceCalendarState {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const activeLoad = useRef<AbortController | null>(null);
  const operations = useRef(new Set<AbortController>());
  const [status, setStatus] = useState<CalendarStatus>('loading');
  const [calendar, setCalendar] = useState<WorkspaceCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    setStatus('loading');
    setError(null);

    try {
      const next = await client.query(
        coreWorkspaceCalendar.workspaceCalendar(workspaceId, from, to),
        { signal: controller.signal, forceRefresh: true },
      );
      if (controller.signal.aborted || activeLoad.current !== controller) return;
      setCalendar(next);
      setStatus('ready');
    } catch (reason) {
      if (controller.signal.aborted || activeLoad.current !== controller || isCanceledError(reason))
        return;
      setCalendar(null);
      setError(calendarError(reason));
      setStatus('error');
    } finally {
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [client, from, to, workspaceId]);

  const write = useCallback(
    async (itemId: string, values: Record<string, string | null>): Promise<boolean> => {
      const controller = new AbortController();
      operations.current.add(controller);
      try {
        await client.execute(coreStructure.setItemProperties(itemId, values), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return false;
        await load();
        return true;
      } catch {
        return false;
      } finally {
        operations.current.delete(controller);
      }
    },
    [client, load],
  );

  const reschedule = useCallback(
    (itemId: string, dateProperty: string, value: string): Promise<boolean> =>
      write(itemId, { [dateProperty]: value }),
    [write],
  );

  const addEndTimes = useCallback(
    async (containerId: string): Promise<string | null> => {
      const refusal = await addEndTimesTo(client, containerId);
      if (refusal === null) {
        await load();
      }
      return refusal;
    },
    [client, load],
  );

  const complete = useCallback(
    async (itemId: string, occurredOn: string): Promise<boolean> => {
      const controller = new AbortController();
      operations.current.add(controller);
      try {
        await client.execute(coreRecurrence.completeOccurrence(itemId, occurredOn), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return false;
        await load();
        return true;
      } catch {
        return false;
      } finally {
        operations.current.delete(controller);
      }
    },
    [client, load],
  );

  const create = useCallback(
    async (containerId: string, title: string, day: string): Promise<string | null> => {
      const controller = new AbortController();
      operations.current.add(controller);
      try {
        const configuredViews = await client.query(
          coreViews.containerViewConfigurations(containerId),
          {
            signal: controller.signal,
            forceRefresh: true,
          },
        );
        const dateProperty =
          configuredViews.views.find((view) => view.kind === 'calendar')?.dateProperty ?? null;
        if (dateProperty === null) {
          return "This note's calendar no longer names a date property, so nothing can be placed there.";
        }

        await client.execute(
          coreItems.createItem(workspaceId, {
            type: 'note',
            title,
            parentId: containerId,
            properties: { [dateProperty]: day },
          }),
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return 'The entry could not be created.';
        await load();
        return null;
      } catch (reason) {
        if (isCanceledError(reason)) return 'The entry could not be created.';
        return requestReason(reason, 'The entry could not be created.');
      } finally {
        operations.current.delete(controller);
      }
    },
    [client, load, workspaceId],
  );

  useEffect(() => {
    let active = true;
    const pendingOperations = operations.current;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      activeLoad.current?.abort();
      for (const controller of pendingOperations) controller.abort();
      pendingOperations.clear();
    };
  }, [load]);

  useEffect(
    () =>
      onItemChildrenChanged((detail) => {
        if (
          detail.workspaceId !== workspaceId ||
          (detail.removedItemIds.length === 0 && detail.restoredItemIds.length === 0)
        )
          return;
        if (detail.removedItemIds.length > 0) {
          const removed = new Set(detail.removedItemIds);
          setCalendar((current) =>
            current === null
              ? null
              : {
                  ...current,
                  entries: current.entries.filter(
                    (entry) => !removed.has(entry.itemId) && !removed.has(entry.containerId),
                  ),
                  unplaceable: current.unplaceable.filter(
                    (entry) =>
                      !removed.has(entry.containerId) &&
                      (entry.itemId === null || !removed.has(entry.itemId)),
                  ),
                },
          );
        }
        void load();
      }),
    [load, workspaceId],
  );

  return {
    status,
    calendar,
    error,
    reload: load,
    reschedule,
    write,
    addEndTimes,
    create,
    complete,
  };
}
