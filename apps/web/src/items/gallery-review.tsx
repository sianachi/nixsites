import { Button, Select, Text } from '@nix/ui';
import type { Item, PropertyDefinition } from '@nix/web-collections/core/container-model';
import { useContainer } from '@nix/web-collections/core/use-container';
import { ensureWorkflowFields } from '@nix/web-collections/core/workflow-fields';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import { fileImageReferenceItemId } from '@nix/web-collections/properties/inputs/image-reference';
import { useFileImagePreview } from '@nix/web-collections/properties/inputs/use-file-image-preview';
import type { ItemProperties } from '@nix/web-collections/properties/use-item-properties';
import { isFetchableImageAddress } from '@nix/web-foundation/lib/image-address';
import type { ItemDialogContextView } from '@nix/web-foundation/lib/item-dialog-context';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useState, type ReactNode } from 'react';
import { FileViewer } from '../files/file-viewer';
import { ContextFields, useContextWrite } from './context-fields';

const REVIEW: PropertyDefinition = {
  key: 'nix_asset_review',
  label: 'Asset review',
  type: 'select',
  options: ['Selected', 'Needs changes'],
  required: false,
};

function CoverPreview({
  source,
  name,
}: {
  readonly source: string;
  readonly name: string;
}): ReactNode {
  const client = useApiClient();
  const fileId = fileImageReferenceItemId(source);
  const file = useFileImagePreview(client, fileId);
  const [failed, setFailed] = useState(false);
  const url =
    fileId !== null
      ? file.status === 'ready'
        ? file.url
        : null
      : isFetchableImageAddress(source)
        ? source
        : null;
  if (fileId !== null && file.status === 'loading')
    return (
      <Text variant="note" role="status">
        Loading image…
      </Text>
    );
  if (url === null || failed)
    return (
      <Text variant="note" tone="muted">
        This cover could not be displayed.
      </Text>
    );
  return (
    <img
      src={url}
      alt={name}
      referrerPolicy="no-referrer"
      className="max-h-[65dvh] w-full object-contain"
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

function AssetPreview({
  item,
  coverKey,
}: {
  readonly item: Item;
  readonly coverKey: string | null;
}): ReactNode {
  const cover = coverKey === null ? null : item.properties[coverKey];
  const name = item.title || 'Untitled';
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-divider p-3">
      <Text as="figcaption" variant="h6">
        {name}
      </Text>
      {item.type === 'file' ? (
        <div className="flex min-h-80 min-w-0 flex-col overflow-hidden">
          <FileViewer itemId={item.id} />
        </div>
      ) : typeof cover === 'string' && cover !== '' ? (
        <CoverPreview key={cover} source={cover} name={name} />
      ) : (
        <Text variant="note" tone="muted">
          This item has no gallery cover.
        </Text>
      )}
    </figure>
  );
}

export function GalleryReview({
  view,
  details,
}: {
  readonly view: Extract<ItemDialogContextView, { kind: 'review' }>;
  readonly details: ItemProperties;
}): ReactNode {
  const gallery = useContainer(view.containerId);
  const { hiddenSet } = useHiddenItems();
  const [compare, setCompare] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = useContextWrite(details);
  const item = details.item;
  if (item === null || details.error !== null)
    return <ContextFields details={details} fields={[]} />;
  const byId = new Map(gallery.children.map((candidate) => [candidate.id, candidate]));
  const alternatives = view.rows.flatMap((id) => {
    const candidate = byId.get(id);
    return candidate === undefined || hiddenSet.has(id) || id === item.id ? [] : [candidate];
  });
  const comparison = alternatives.find((candidate) => candidate.id === compare);
  const status = item.properties[REVIEW.key];

  async function mark(next: string | null): Promise<void> {
    setSaving(true);
    setError(null);
    const setup = await ensureWorkflowFields(gallery, [REVIEW]);
    const refusal = setup ?? (await write({ [REVIEW.key]: next }));
    setSaving(false);
    setError(refusal);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Text role="status" variant="bodySmall" className="mr-auto">
          {typeof status === 'string' ? status : 'Awaiting review'}
        </Text>
        <Button
          variant="secondary"
          aria-pressed={status === 'Selected'}
          disabled={saving || gallery.schema === null}
          onClick={() => void mark('Selected')}
        >
          Select asset
        </Button>
        <Button
          variant="secondary"
          aria-pressed={status === 'Needs changes'}
          disabled={saving || gallery.schema === null}
          onClick={() => void mark('Needs changes')}
        >
          Request changes
        </Button>
        {typeof status === 'string' ? (
          <Button variant="subtle" disabled={saving} onClick={() => void mark(null)}>
            Clear decision
          </Button>
        ) : null}
      </div>
      {error === null && gallery.status !== 'error' ? null : (
        <Text role="alert" variant="note">
          {error ?? gallery.error}
        </Text>
      )}
      {alternatives.length === 0 ? null : (
        <Select
          aria-label="Compare with another asset"
          className="max-w-full self-start"
          value={comparison?.id ?? ''}
          onChange={(event) => {
            setCompare(event.target.value);
          }}
        >
          <option value="">Compare with another asset</option>
          {alternatives.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title || 'Untitled'}
            </option>
          ))}
        </Select>
      )}
      <div className="flex flex-col gap-3 md:flex-row">
        <AssetPreview item={item} coverKey={view.coverKey} />
        {comparison === undefined ? null : (
          <AssetPreview item={comparison} coverKey={view.coverKey} />
        )}
      </div>
    </>
  );
}
