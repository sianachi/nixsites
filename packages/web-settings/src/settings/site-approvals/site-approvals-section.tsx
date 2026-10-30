import type { SiteApprovalEntry } from '@nix/api-client';
import { ScrollRegion, Button, Dialog, Field, Table, Text, Textarea } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import { ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { SettingsSection } from '../shared/settings-section';
import { formatDateTime } from '@nix/web-foundation/lib/date-format';
import { useSiteApprovals } from './use-site-approvals';

interface Deciding {
  readonly entry: SiteApprovalEntry;
  readonly decision: 'approve' | 'reject';
}

/**
 * Sites whose first publish waits for a decision. Approving makes the site public, so both
 * decisions go through a dialog; rejecting takes an optional note the site's managers will read.
 */
export function SiteApprovalsSection(): ReactElement {
  const { status, approvals, error, busySiteId, reload, decide } = useSiteApprovals();
  const [deciding, setDeciding] = useState<Deciding | null>(null);
  const narrow = useNarrowViewport();

  const decisionButtons = (entry: SiteApprovalEntry): ReactElement => (
    <span className="inline-flex gap-2">
      {(['approve', 'reject'] as const).map((decision) => (
        <Button
          key={decision}
          variant="secondary"
          disabled={busySiteId !== null}
          aria-label={`${decision === 'approve' ? 'Approve' : 'Reject'} ${entry.name}`}
          onClick={() => {
            setDeciding({ entry, decision });
          }}
        >
          {decision === 'approve' ? 'Approve' : 'Reject'}
        </Button>
      ))}
    </span>
  );

  const columns = [
    {
      key: 'site',
      header: 'Site',
      rowHeader: true,
      cell: (entry: SiteApprovalEntry) => (
        <span className="break-words">{`${entry.name} (${entry.slug})`}</span>
      ),
    },
    {
      key: 'hostnames',
      header: 'Hostnames',
      cell: (entry: SiteApprovalEntry) => entry.hostnames.join(', '),
    },
    {
      key: 'requestedBy',
      header: 'Asked by',
      cell: (entry: SiteApprovalEntry) => (
        <span title={entry.requestedBy}>{entry.requestedBy.slice(0, 8)}</span>
      ),
    },
    {
      key: 'requestedAt',
      header: 'Asked',
      cell: (entry: SiteApprovalEntry) => formatDateTime(new Date(entry.approval.requestedAt)),
    },
    {
      key: 'actions',
      header: 'Decision',
      cell: decisionButtons,
    },
  ] as const;

  return (
    <SettingsSection
      title="Site approvals"
      summary="A site's first publish waits here; approving makes it public"
    >
      {status === 'error' ? (
        <ErrorPanel
          title="Site approvals could not be loaded"
          detail={error ?? 'Something went wrong reading the approvals.'}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : narrow ? (
        <ul
          aria-label="Sites waiting for a decision"
          className="flex flex-col divide-y divide-divider"
        >
          {approvals.length === 0 ? (
            <Text variant="note" tone="muted" role="status">
              {status === 'loading'
                ? 'Loading the site approvals.'
                : 'No site is waiting for approval.'}
            </Text>
          ) : null}
          {approvals.map((entry) => (
            <li key={entry.siteId} className="flex flex-col gap-2 py-3">
              <Text as="p" variant="bodySmall" className="break-words">
                {`${entry.name} (${entry.slug})`}
              </Text>
              <Text as="p" variant="caption" tone="muted" className="break-words">
                {`${entry.hostnames.join(', ')} · asked ${formatDateTime(new Date(entry.approval.requestedAt))}`}
              </Text>
              {decisionButtons(entry)}
            </li>
          ))}
        </ul>
      ) : (
        <ScrollRegion className="min-w-0 overflow-x-auto" aria-label="Site approvals table">
          <Table
            caption="Sites waiting for a decision on their first publish."
            columns={columns}
            rows={approvals}
            rowKey={(entry) => entry.siteId}
            loading={status === 'loading'}
            loadingMessage="Loading the site approvals."
            emptyMessage="No site is waiting for approval. A request appears here when a site’s manager asks to publish for the first time."
          />
        </ScrollRegion>
      )}

      {deciding === null ? null : (
        <DecisionDialog
          deciding={deciding}
          onClose={() => {
            setDeciding(null);
          }}
          onDecide={(note) => decide(deciding.entry.siteId, deciding.decision, note)}
        />
      )}
    </SettingsSection>
  );
}

function DecisionDialog({
  deciding,
  onDecide,
  onClose,
}: {
  readonly deciding: Deciding;
  readonly onDecide: (note: string | undefined) => Promise<string | null>;
  readonly onClose: () => void;
}): ReactElement {
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approving = deciding.decision === 'approve';
  const label = approving ? 'Approve' : 'Reject';

  return (
    <Dialog
      open
      title={`${label} ${deciding.entry.name}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={working}
            onClick={() => {
              setWorking(true);
              setError(null);
              void onDecide(approving || note.trim() === '' ? undefined : note.trim()).then(
                (refusal) => {
                  setWorking(false);
                  if (refusal === null) onClose();
                  else setError(refusal);
                },
              );
            }}
          >
            {approving ? 'Approve and publish' : 'Reject'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {approving ? (
          <Text>
            {`This starts the first publish and makes ${deciding.entry.name} public at ${deciding.entry.hostnames.join(', ')}.`}
          </Text>
        ) : (
          <Field label="Note (optional)" hint="Shown to the site’s managers.">
            {(control) => (
              <Textarea
                {...control}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
        )}
        {error === null ? null : (
          <Text role="alert" variant="note">
            {error}
          </Text>
        )}
      </div>
    </Dialog>
  );
}
