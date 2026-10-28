import {
  cacheKeyToString,
  isCanceledError,
  isNixApiError,
  templates as coreTemplates,
  type CacheEntry,
  type TemplateCatalog,
  type TemplateSummary,
} from '@nix/api-client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';

export type TemplateLibraryStatus = 'loading' | 'ready' | 'error';

function noCachedTemplateLibrary(): CacheEntry<TemplateCatalog> | undefined {
  return undefined;
}

export function templateFailure(error: unknown, fallback: string): string {
  if (isNixApiError(error)) {
    return error.detail ?? fallback;
  }
  return fallback;
}

export interface TemplateLibrary {
  readonly status: TemplateLibraryStatus;
  readonly templates: readonly TemplateSummary[];
  readonly error: string | null;
  readonly capabilities: { readonly canManage: boolean };
  readonly reload: () => void;
}

export function useTemplates(): TemplateLibrary {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  // These identities are dependencies of the cache subscription and load effect. Recreating them
  // on every render resubscribes and issues another GET even when the workspace did not change.
  const templateLibraryKey = useMemo(
    () => coreTemplates.templateLibraryKey(workspaceId),
    [workspaceId],
  );
  const templateLibraryKeyId = cacheKeyToString(templateLibraryKey);
  const templateLibraryEndpoint = useMemo(
    () => coreTemplates.listTemplates(workspaceId),
    [workspaceId],
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const handledReload = useRef(-1);

  // Stable identities are required by useSyncExternalStore; changing either function would
  // unsubscribe and resubscribe on every render.
  const subscribe = useCallback(
    (notify: () => void) =>
      client.cache.subscribe((changedKey) => {
        if (cacheKeyToString(changedKey) === templateLibraryKeyId) notify();
      }),
    [client, templateLibraryKeyId],
  );
  const getSnapshot = useCallback(
    () => client.cache.peek<TemplateCatalog>(templateLibraryKey),
    [client, templateLibraryKey],
  );
  const cached = useSyncExternalStore(subscribe, getSnapshot, noCachedTemplateLibrary);

  useEffect(() => {
    const explicitReload = handledReload.current !== reloadKey;
    handledReload.current = reloadKey;
    if (!explicitReload && cached !== undefined && !cached.stale) return;

    const controller = new AbortController();

    void client
      .query(templateLibraryEndpoint, {
        signal: controller.signal,
        forceRefresh: explicitReload || cached?.stale === true,
      })
      .then(() => {
        setError(null);
      })
      .catch((reason: unknown) => {
        if (isCanceledError(reason)) return;
        setError(templateFailure(reason, 'Templates could not be loaded. Check the connection.'));
      });

    return () => {
      controller.abort();
    };
  }, [cached, client, reloadKey, templateLibraryEndpoint]);

  // Stable because consumers may use reload as an effect or event dependency.
  const reload = useCallback(() => {
    setError(null);
    setReloadKey((current) => current + 1);
  }, []);

  return {
    status: error !== null ? 'error' : cached === undefined ? 'loading' : 'ready',
    templates: cached?.data.templates ?? [],
    error,
    capabilities: cached?.data.capabilities ?? { canManage: false },
    reload,
  };
}
