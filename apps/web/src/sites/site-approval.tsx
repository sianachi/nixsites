import { sites, type Site } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { refusalMessage } from './site-copy';

/**
 * The operator's approval of a first publish, on deployments that ask for it: a manager asks once
 * (acknowledging the content becomes public), then sees "Waiting for approval", or the operator's
 * reason for a rejection. Renders nothing where no approval is needed.
 */
export function SiteApproval({ site }: { readonly site: Site }): ReactNode {
  // Optional, so the pane still renders where no client is provided (stories); actions then refuse.
  const client = useOptionalApiClient();
  return (
    <SiteApprovalView
      site={site}
      request={async () => {
        if (client === null) return { site: null, error: 'Not connected to Nix.' };
        try {
          return {
            site: await client.execute(sites.requestSiteApproval(site.id, true)),
            error: null,
          };
        } catch (error) {
          return { site: null, error: refusalMessage(error) };
        }
      }}
    />
  );
}

/** The notice without its data source, for stories and tests. */
export function SiteApprovalView({
  site,
  request,
}: {
  readonly site: Site;
  readonly request: () => Promise<{ readonly site: Site | null; readonly error: string | null }>;
}): ReactNode {
  const [current, setCurrent] = useState(site);
  const [seen, setSeen] = useState(site);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (seen !== site) {
    setSeen(site);
    setCurrent(site);
  }

  if (!current.approvalRequired) return null;
  const approval = current.approval;
  const pending = approval?.state === 'pending';

  return (
    <section aria-label="Approval" className="flex flex-col gap-2">
      <Text variant="note" role="status">
        {pending
          ? 'Waiting for approval. The operator approves each site’s first publish; it starts on its own once approved.'
          : approval?.state === 'rejected'
            ? `The operator did not approve publishing${approval.note === null ? '.' : `: ${approval.note}`}`
            : 'On this server, the operator approves each site’s first publish. Ask once; publishing starts when it is approved.'}
      </Text>
      {current.canManage && !pending ? (
        <div>
          <Button
            disabled={working}
            onClick={() => {
              setWorking(true);
              setError(null);
              void request().then((result) => {
                setWorking(false);
                setError(result.error);
                if (result.site !== null) setCurrent(result.site);
              });
            }}
          >
            Ask for approval
          </Button>
          <Text variant="note" tone="muted">
            Once approved, the content becomes public. Search engines and archives may keep copies.
          </Text>
        </div>
      ) : null}
      {error === null ? null : (
        <Text role="alert" variant="note">
          {error}
        </Text>
      )}
    </section>
  );
}
