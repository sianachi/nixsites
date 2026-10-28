import {
  calendarSync,
  isCanceledError,
  isNixApiError,
  type CalendarConnection,
  type CalendarLink,
  type CalendarSyncLogEntry,
  type ExternalCalendar,
  type WorkspaceCalendarLink,
} from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';

/**
 * The caller's calendar sync: the accounts they have connected at Google and Microsoft, and the
 * links that mirror one external calendar into one container.
 *
 * The hook owns the screen's states and the wording of a refusal; the descriptors own the paths.
 * Every write answers with a refusal string or null rather than throwing, so the dialog a person
 * is looking at can say what went wrong where they are looking.
 */

export type CalendarSyncStatus = 'loading' | 'ready' | 'error';

export interface CalendarProviderAvailability {
  readonly provider: string;
  readonly available: boolean;
}

export interface Refusal {
  readonly refusal: string | null;
}

export interface CalendarSyncState {
  readonly status: CalendarSyncStatus;
  readonly providers: readonly CalendarProviderAvailability[];
  readonly connections: readonly CalendarConnection[];
  readonly links: readonly CalendarLink[];

  /**
   * Containers in the current workspace that another member linked a calendar into. Only ever
   * filled for somebody who manages the workspace; for everybody else Core answers "not found"
   * and this stays empty, which is the honest reading - there is nothing here for them to act on.
   */
  readonly othersLinks: readonly WorkspaceCalendarLink[];
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  /** Starts the provider's consent flow. On success the browser leaves this page. */
  readonly connect: (provider: string, returnTo: string) => Promise<Refusal>;
  readonly disconnect: (connectionId: string) => Promise<Refusal>;
  readonly calendarsOf: (connectionId: string) => Promise<{
    readonly calendars: readonly ExternalCalendar[];
    readonly refusal: string | null;
  }>;
  readonly link: (input: calendarSync.CreateCalendarLinkInput) => Promise<Refusal>;
  readonly update: (
    link: CalendarLink,
    change: { readonly direction?: string; readonly status?: string },
  ) => Promise<Refusal>;
  readonly unlink: (linkId: string, items: 'keep' | 'trash') => Promise<Refusal>;

  /** Unlinks a calendar another member linked, on the authority of managing the workspace. */
  readonly unlinkOthers: (containerItemId: string, items: 'keep' | 'trash') => Promise<Refusal>;
  readonly sync: (linkId: string) => Promise<Refusal>;
  readonly logOf: (linkId: string) => Promise<{
    readonly entries: readonly CalendarSyncLogEntry[];
    readonly refusal: string | null;
  }>;
}

/** What each stable refusal code means to the person, where the server's own detail is absent. */
const REFUSALS: Readonly<Record<string, string>> = {
  'calendar.provider_unavailable': 'This server is not set up to connect that provider.',
  'calendar.needs_reauth': 'The account needs to be connected again before it can sync.',
  'calendar.link_exists': 'That calendar is already linked.',
  'calendar.conflict': 'The link changed since it was loaded. Reload and try again.',
  'calendar.link_inactive': 'The link is paused or stopped, so it cannot sync.',
  'calendar.calendar_not_found': 'That calendar is no longer in the account.',
};

function refusalOf(reason: unknown, action: string): string {
  if (isNixApiError(reason)) {
    const known = REFUSALS[reason.code];
    if (known !== undefined) {
      return known;
    }
    if (reason.code === 'calendar.invalid' && reason.detail !== undefined) {
      return reason.detail;
    }
    if (reason.status !== undefined) {
      return `${action} failed (${String(reason.status)}).`;
    }
  }
  return `${action} could not be sent. Check the connection and try again.`;
}

export function useCalendarSync(): CalendarSyncState {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();

  const [status, setStatus] = useState<CalendarSyncStatus>('loading');
  const [providers, setProviders] = useState<readonly CalendarProviderAvailability[]>([]);
  const [connections, setConnections] = useState<readonly CalendarConnection[]>([]);
  const [links, setLinks] = useState<readonly CalendarLink[]>([]);
  const [othersLinks, setOthersLinks] = useState<readonly WorkspaceCalendarLink[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal, forceRefresh = false): Promise<void> => {
      setError(null);
      try {
        const [accounts, linked] = await Promise.all([
          client.query(calendarSync.listConnections(), { signal, forceRefresh }),
          client.query(calendarSync.listLinks(), { signal, forceRefresh }),
        ]);
        setProviders(accounts.providers);
        setConnections(accounts.connections);
        setLinks(linked.links);
        setStatus('ready');

        // Read after the caller's own, and apart from them: a refusal here is the ordinary
        // answer for anybody who does not manage the workspace, not a failure of the screen.
        const mine = new Set(linked.links.map((link) => link.containerItemId));
        try {
          const all = await client.query(calendarSync.listWorkspaceLinks(workspaceId), {
            signal,
            forceRefresh: true,
          });
          setOthersLinks(all.links.filter((entry) => !mine.has(entry.containerItemId)));
        } catch (cause) {
          if (!(signal?.aborted === true || isCanceledError(cause))) {
            setOthersLinks([]);
          }
        }
      } catch (cause) {
        if (signal?.aborted === true || isCanceledError(cause)) {
          return;
        }
        console.warn('The calendar connections read failed.', cause);
        setError(
          isNixApiError(cause) && cause.status !== undefined
            ? `Your calendars could not be loaded (${String(cause.status)}).`
            : 'Core could not be reached.',
        );
        setStatus('error');
      }
    },
    [client, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    // queueMicrotask so the first setState lands after the effect returns rather than during it,
    // the same cascade-stopper `use-workspace-tree.ts` documents.
    queueMicrotask(() => {
      void load(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, [load]);

  const reload = useCallback(async (): Promise<void> => {
    await load(undefined, true);
  }, [load]);

  /** Runs one write, reloads on success, and turns a failure into its refusal. */
  const write = useCallback(
    async (action: string, run: () => Promise<unknown>): Promise<Refusal> => {
      try {
        await run();
      } catch (reason) {
        return { refusal: refusalOf(reason, action) };
      }
      await load(undefined, true);
      return { refusal: null };
    },
    [load],
  );

  const connect = useCallback(
    async (provider: string, returnTo: string): Promise<Refusal> => {
      try {
        const { authorizationUrl } = await client.execute(
          calendarSync.authorize(provider, returnTo),
        );
        window.location.assign(authorizationUrl);
        return { refusal: null };
      } catch (reason) {
        return { refusal: refusalOf(reason, 'Connecting') };
      }
    },
    [client],
  );

  const calendarsOf = useCallback(
    async (connectionId: string) => {
      try {
        const listed = await client.query(calendarSync.listExternalCalendars(connectionId), {
          forceRefresh: true,
        });
        return { calendars: listed.calendars, refusal: null };
      } catch (reason) {
        return { calendars: [], refusal: refusalOf(reason, 'Reading the account') };
      }
    },
    [client],
  );

  const logOf = useCallback(
    async (linkId: string) => {
      try {
        const page = await client.query(calendarSync.listLog(linkId), { forceRefresh: true });
        return { entries: page.entries, refusal: null };
      } catch (reason) {
        return { entries: [], refusal: refusalOf(reason, 'Reading the log') };
      }
    },
    [client],
  );

  return {
    status,
    providers,
    connections,
    links,
    othersLinks,
    error,
    reload,
    connect,
    disconnect: (connectionId) =>
      write('Disconnecting', () => client.execute(calendarSync.deleteConnection(connectionId))),
    calendarsOf,
    link: (input) => write('Linking', () => client.execute(calendarSync.createLink(input))),
    update: (link, change) =>
      write('The change', () =>
        client.execute(calendarSync.updateLink(link.id, { revision: link.revision, ...change })),
      ),
    unlink: (linkId, items) =>
      write('Unlinking', () => client.execute(calendarSync.deleteLink(linkId, items))),
    unlinkOthers: (containerItemId, items) =>
      write('Unlinking', () =>
        client.execute(calendarSync.unlinkWorkspaceLink(workspaceId, containerItemId, items)),
      ),
    sync: (linkId) => write('The sync', () => client.execute(calendarSync.syncLink(linkId))),
    logOf,
  };
}
