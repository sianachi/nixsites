import type { SiteRepublishMode } from '@nix/api-client';
import { Button, Checkbox, Dialog, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

/**
 * Publishing a site that is not live: the first time, or again after it was unpublished. Publishing makes the pages public, and public pages can be copied
 * by search engines and web archives that Nix cannot reach afterwards, so the first publish waits
 * for somebody to say they understand that. Core refuses a first publish without it too.
 */
export function SitePublishDialog({
  open,
  url,
  republishMode,
  onPublish,
  onClose,
}: {
  readonly open: boolean;
  /** The address the site will be served at. */
  readonly url: string | null;
  /** How later edits reach the site, so the dialog can say whether they go public on their own. */
  readonly republishMode: SiteRepublishMode;
  /** Resolves to a refusal message, or null once the build was queued. */
  readonly onPublish: () => Promise<string | null>;
  readonly onClose: () => void;
}): ReactNode {
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function publish(): Promise<void> {
    setWorking(true);
    setError(null);
    const refusal = await onPublish();
    setWorking(false);
    if (refusal === null) onClose();
    else setError(refusal);
  }

  return (
    <Dialog
      open={open}
      title="Publish this site"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!acknowledged || working}
            onClick={() => {
              void publish();
            }}
          >
            {working ? 'Publishing…' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Text>
          {`Anyone on the internet can find and read this item and everything inside it${url === null ? '' : ` at ${url}`}. The site lists its pages for search engines. Locked, trashed and left-out items are never published.`}
        </Text>
        <Text>
          {republishMode === 'auto'
            ? 'Automatic publishing is on: every saved edit goes public on its own once it settles.'
            : republishMode === 'on_release'
              ? 'Later edits go public whenever this Nix server is updated, or when you publish again.'
              : 'Later edits are not public until you publish again.'}
        </Text>
        <Text>
          Search engines and web archives may keep copies of public pages. Unpublishing removes the
          site, but it cannot recall copies made while it was live.
        </Text>
        <Checkbox
          label="I understand this site will be public and may be copied."
          checked={acknowledged}
          onChange={(event) => {
            setAcknowledged(event.currentTarget.checked);
          }}
        />
        {error === null ? null : (
          <Text role="alert" variant="note">
            {error}
          </Text>
        )}
      </div>
    </Dialog>
  );
}
