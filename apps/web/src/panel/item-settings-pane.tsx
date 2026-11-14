import { attachments as attachmentsApi, type ItemSettings } from '@nix/api-client';
import { Button, Checkbox, Dialog, Field, Select, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { readComments } from '@nix/web-editor/editor/comment-anchors';
import { DOCUMENT_VIEW } from '@nix/web-collections/core/container-model';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import type { ItemProperties } from '@nix/web-collections/properties/use-item-properties';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';

type SettingKey = keyof ItemSettings;

interface Entry {
  readonly key: SettingKey;
  readonly label: string;
  readonly description: string;
}

const NOTE_ENTRIES: readonly Entry[] = [
  {
    key: 'comments',
    label: 'Comments',
    description:
      'Let people discuss this note in threads. Turning it off hides the threads without deleting them.',
  },
  {
    key: 'suggesting',
    label: 'Suggesting',
    description:
      'Offer a Suggesting mode that records edits as suggestions to accept or reject. Suggestions already in the text stay.',
  },
  {
    key: 'fullWidth',
    label: 'Full width',
    description: 'Let the note use the full width of its pane instead of a reading width.',
  },
];

const FILE_ENTRY: Entry = {
  key: 'reviewStates',
  label: 'Review states',
  description:
    'Move each version through draft, in review and approved. Off, the newest version is the one shared.',
};

/**
 * What this one item can do: the optional features it switches on for itself, and which view it
 * opens as. Everything is off until someone turns it on, and Core enforces it for every client.
 */
export function ItemSettingsPane({
  container,
  details,
}: {
  readonly container: ContainerData;
  readonly details: ItemProperties;
}): ReactNode {
  const client = useApiClient();
  const { item } = details;
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmReviewOff, setConfirmReviewOff] = useState(false);

  if (item === null) {
    return (
      <Text variant="note" tone="muted">
        Loading this item&rsquo;s settings…
      </Text>
    );
  }

  const settings = item.settings ?? {
    comments: false,
    suggesting: false,
    reviewStates: false,
    fullWidth: false,
  };
  const entries = item.type === 'file' ? [FILE_ENTRY] : item.type === 'note' ? NOTE_ENTRIES : [];
  const views = container.views;
  const choices = views?.views.filter((view) => !views.unrenderable.includes(view.id)) ?? [];

  async function apply(change: Partial<ItemSettings>): Promise<void> {
    setProblem(null);
    const refused = await details.setSettings(change);
    if (refused !== null) {
      setProblem(refused);
      return;
    }
    // Comments off hides the threads and on brings them back: re-read the note's list now.
    if (item !== null && change.comments !== undefined) readComments(item.id).refresh();
  }

  async function toggle(key: SettingKey, next: boolean): Promise<void> {
    if (key === 'reviewStates' && !next && item !== null) {
      const link = await client
        .query(attachmentsApi.getPublicLink(item.id), { forceRefresh: true })
        .catch(() => null);
      if (link !== null) {
        setConfirmReviewOff(true);
        return;
      }
    }
    await apply({ [key]: next });
  }

  return (
    <div className="flex flex-col gap-4">
      {entries.map((entry) => (
        <div key={entry.key} className="flex flex-col gap-0.5">
          <Checkbox
            label={entry.label}
            checked={settings[entry.key]}
            onChange={(event) => {
              void toggle(entry.key, event.target.checked);
            }}
          />
          <Text variant="note" tone="muted" className="ps-(--control-sm)">
            {entry.description}
          </Text>
        </div>
      ))}

      {views === null ? null : (
        <Field label="Default view" hint="What this item opens as for everyone in the workspace.">
          {(field) => (
            <Select
              {...field}
              value={views.default}
              onChange={(event) => {
                void container.setDefaultView(event.target.value).then((refused) => {
                  setProblem(refused);
                });
              }}
            >
              <option value={DOCUMENT_VIEW}>Document</option>
              {choices.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      {problem === null ? null : (
        <Text variant="note" role="alert">
          {problem}
        </Text>
      )}

      <Dialog
        open={confirmReviewOff}
        title="Turn off review states?"
        onClose={() => {
          setConfirmReviewOff(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmReviewOff(false);
              }}
            >
              Keep review states
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmReviewOff(false);
                void apply({ reviewStates: false });
              }}
            >
              Turn off
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">
          This file has a public link. Without review states, the newest version of the file is
          shared, even if nobody has reviewed it yet.
        </Text>
      </Dialog>
    </div>
  );
}
