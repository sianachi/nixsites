import {
  isCanceledError,
  isNixApiError,
  sites,
  tenantRoles,
  type NixClient,
} from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly since: string | null;
  /** `configured` people come from deployment configuration and cannot be removed here. */
  readonly configured: boolean;
}

/** One list of people who hold a power, with the calls that change it. Module-level, so stable. */
export interface PeopleSource {
  readonly list: (client: NixClient, signal: AbortSignal | undefined) => Promise<readonly Person[]>;
  readonly grant: (id: string) => Parameters<NixClient['execute']>[0];
  readonly revoke: (id: string) => Parameters<NixClient['execute']>[0];
}

export const TENANT_ADMINS: PeopleSource = {
  list: async (client, signal) =>
    (await client.query(tenantRoles.listTenantRoles(), { signal, forceRefresh: true })).items.map(
      (grant) => ({
        id: grant.subjectId,
        name: grant.subjectDisplayName,
        since: grant.grantedAt,
        configured: false,
      }),
    ),
  grant: tenantRoles.grantTenantAdmin,
  revoke: tenantRoles.revokeTenantAdmin,
};

export const SITE_APPROVERS: PeopleSource = {
  list: async (client, signal) =>
    (await client.query(sites.listSiteOperators(), { signal, forceRefresh: true })).operators.map(
      (operator) => ({
        id: operator.principalId,
        name: operator.displayName,
        since: operator.grantedAt,
        configured: operator.source === 'configured',
      }),
    ),
  grant: sites.grantSiteOperator,
  revoke: sites.revokeSiteOperator,
};

const REFUSALS: Readonly<Record<string, string>> = {
  'roles.last_administrator':
    'This is the last tenant administrator. Make someone else an administrator first.',
  'sites.operator_configured':
    'This approver is set in the deployment’s configuration and cannot be removed here.',
};

function message(cause: unknown, fallback: string): string {
  if (!isNixApiError(cause)) return 'Core could not be reached.';
  return REFUSALS[cause.code] ?? cause.detail ?? fallback;
}

export type PeopleStatus = 'loading' | 'ready' | 'error';

export interface PeopleState {
  readonly status: PeopleStatus;
  readonly people: readonly Person[];
  /** Why the list could not load. */
  readonly error: string | null;
  /** Why the last add or remove was refused. */
  readonly actionError: string | null;
  readonly busyId: string | null;
  readonly reload: () => Promise<void>;
  readonly add: (id: string) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
}

export function usePeople(source: PeopleSource): PeopleState {
  const client = useApiClient();
  const [status, setStatus] = useState<PeopleStatus>('loading');
  const [people, setPeople] = useState<readonly Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        setPeople(await source.list(client, signal));
        setError(null);
        setStatus('ready');
      } catch (cause) {
        if (signal?.aborted === true || isCanceledError(cause)) return;
        setError(message(cause, 'The list could not be loaded.'));
        setStatus('error');
      }
    },
    [client, source],
  );

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      void load(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, [load]);

  const reload = useCallback(async (): Promise<void> => {
    setStatus('loading');
    await load();
  }, [load]);

  const change = useCallback(
    async (id: string, endpoint: Parameters<NixClient['execute']>[0]): Promise<void> => {
      setBusyId(id);
      setActionError(null);
      try {
        await client.execute(endpoint);
        await load();
      } catch (cause) {
        setActionError(message(cause, 'The change was refused.'));
      }
      setBusyId(null);
    },
    [client, load],
  );

  return {
    status,
    people,
    error,
    actionError,
    busyId,
    reload,
    add: (id) => change(id, source.grant(id)),
    remove: (id) => change(id, source.revoke(id)),
  };
}
