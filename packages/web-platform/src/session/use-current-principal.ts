import {
  isCanceledError,
  isNixApiError,
  principal as principalResource,
  type CurrentPrincipal,
} from '@nix/api-client';
import { useCallback, useEffect, useState } from 'react';

import { useApiClient } from '../api/api-client-provider';

/**
 * The signed-in caller, from `GET /api/v1/me`.
 *
 * **Fetched rather than decoded from the token, and that is the whole reason this exists.** Roles
 * live in the database and never in tokens, so whether somebody is a tenant administrator cannot
 * be read out of the OIDC profile the browser already holds - it has to be asked, and the answer
 * is only as old as the request.
 *
 * The flag it carries decides what the profile menu offers. It grants nothing: every
 * administrative endpoint asks the database the same question for itself, so a client that flipped
 * the flag in a debugger would gain a menu entry and no capability at all.
 */

export type PrincipalStatus = 'loading' | 'ready' | 'error';

export interface CurrentPrincipalState {
  readonly status: PrincipalStatus;
  readonly principal: CurrentPrincipal | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

export function useCurrentPrincipal(): CurrentPrincipalState {
  const client = useApiClient();

  const [status, setStatus] = useState<PrincipalStatus>('loading');
  const [principal, setPrincipal] = useState<CurrentPrincipal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      const loaded = await client.query(principalResource.currentPrincipal());
      setPrincipal(loaded);
      setStatus('ready');
    } catch (reason) {
      if (isCanceledError(reason)) return;
      if (isNixApiError(reason) && reason.status !== undefined) {
        setError(`Your profile could not be loaded (${String(reason.status)}).`);
      } else {
        setError('Core could not be reached.');
      }
      setStatus('error');
    }
  }, [client]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return { status, principal, error, reload: load };
}
