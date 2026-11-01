import { health, isCanceledError, type ServiceVersion } from '@nix/api-client';
import { Button, Tag, Text } from '@nix/ui';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { ErrorPanel, LoadingPanel } from '@nix/web-foundation/components/states/status-panels';
import { formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import { useWebConfig } from '@nix/web-foundation/lib/web-config';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { SettingsSection } from '../shared/settings-section';

/** A readable name for a service as Core reports it; workers carry their roles after a colon. */
export function serviceLabel(service: string): string {
  if (service === 'web') return 'Web app';
  if (service === 'api') return 'Core API';
  if (service === 'collab') return 'Collaboration';
  if (service === 'sites-worker') return 'Sites worker';
  if (service.startsWith('worker:')) {
    const roles = service.slice('worker:'.length);
    return roles === '' ? 'Worker' : `Worker (${roles.replaceAll(',', ', ')})`;
  }
  return service;
}

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly services: readonly ServiceVersion[] }
  | { readonly status: 'error' };

/**
 * The exact release every part of this deployment runs: the web app from its own config, Core
 * from its environment, and the other services as they last reported to Core. A service whose
 * commit differs from Core's is flagged, which is what a half-finished deploy looks like.
 */
export function AboutSection(): ReactElement {
  const client = useApiClient();
  const web = useWebConfig().release;
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setState({ status: 'loading' });
      try {
        const loaded = await client.query(health.systemVersions(), { signal, forceRefresh: true });
        setState({ status: 'ready', services: loaded.services });
      } catch (cause) {
        if (signal?.aborted === true || isCanceledError(cause)) return;
        console.warn('The service versions read failed.', cause);
        setState({ status: 'error' });
      }
    },
    [client],
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

  const services: readonly ServiceVersion[] =
    state.status === 'ready'
      ? [
          ...(web === undefined
            ? []
            : [{ service: 'web', version: web.version, commit: web.commit, reportedAt: '' }]),
          ...state.services,
        ]
      : [];
  const coreCommit = services.find((entry) => entry.service === 'api')?.commit ?? '';

  return (
    <SettingsSection title="About" summary="The exact release each service of this deployment runs">
      {state.status === 'loading' ? <LoadingPanel label="service versions" /> : null}
      {state.status === 'error' ? (
        <ErrorPanel
          title="Service versions could not be loaded"
          detail="Core could not be reached."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void load();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : null}
      {state.status === 'ready' ? (
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr]">
          {services.map((entry) => (
            <div key={entry.service} className="contents">
              <Text as="dt" variant="bodySmall">
                {serviceLabel(entry.service)}
              </Text>
              <Text as="dd" variant="bodySmall" className="flex flex-wrap items-center gap-2">
                <span>{entry.version === '' ? 'Version not set' : entry.version}</span>
                {entry.commit === '' ? null : (
                  <code className="font-mono text-sm" title={entry.commit}>
                    {entry.commit.slice(0, 12)}
                  </code>
                )}
                {coreCommit !== '' && entry.commit !== '' && entry.commit !== coreCommit ? (
                  <Tag tone="accent">Differs from Core</Tag>
                ) : null}
                {entry.service === 'api' || entry.reportedAt === '' ? null : (
                  <Text as="span" variant="note" tone="muted">
                    reported {formatRelativeTime(new Date(entry.reportedAt))}
                  </Text>
                )}
              </Text>
            </div>
          ))}
        </dl>
      ) : null}
      {state.status === 'ready' ? (
        <Text variant="note" tone="muted">
          Services appear once they have called Core since it last started.
        </Text>
      ) : null}
    </SettingsSection>
  );
}
