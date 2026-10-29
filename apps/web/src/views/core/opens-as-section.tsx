import { Checkbox, Field, Select, Text } from '@nix/ui';
import { useId, useState, type ReactNode } from 'react';

import { DOCUMENT_VIEW } from '@nix/web-collections/core/container-model';
import type { ContainerData } from '@nix/web-collections/core/use-container';

/**
 * What an item opens as, and whether its document keeps a tab.
 *
 * **Item-level, so it sits apart from the views.** Both settings belong to the item rather than to
 * any one view, and both apply to everybody who opens it. They are also written the moment they
 * are chosen, not with "Save views": a choice that waited for a button further down the panel
 * would look like one that had already taken effect.
 *
 * The default is chosen here, on purpose. Clicking a tab only moves you; if that also rewrote the
 * default, a glance at another tab would change what the item opens as for everyone.
 */

export function OpensAsSection({ container }: { readonly container: ContainerData }): ReactNode {
  const hintId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stored = container.views;
  const offered = stored?.views ?? [];
  const hidden = stored?.hideDocument === true;
  const noViews = offered.length === 0;

  // Core never leaves a hidden document as the default, but a response from before the flag was
  // set could say so for a moment; showing the first view keeps the select naming something real.
  const current = hidden && stored.default === DOCUMENT_VIEW ? offered[0]?.id : stored?.default;

  async function write(change: () => Promise<string | null>): Promise<void> {
    setPending(true);
    setError(null);
    const refusal = await change();
    setPending(false);
    setError(refusal);
  }

  return (
    <section aria-label="When this item opens" className="flex flex-col gap-3">
      <Text variant="bodySmall" as="h3">
        When this item opens
      </Text>

      <Field label="Open as" hint="What this item shows first, for everybody who opens it.">
        {(control) => (
          <Select
            {...control}
            value={current ?? DOCUMENT_VIEW}
            disabled={noViews || pending}
            onChange={(event) => {
              void write(() => container.setDefaultView(event.target.value));
            }}
          >
            {hidden ? null : <option value={DOCUMENT_VIEW}>Document</option>}
            {offered.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="flex flex-col gap-1">
        <Checkbox
          label="Hide the Document tab"
          aria-describedby={hintId}
          checked={hidden}
          disabled={noViews || pending}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            void write(() => container.setDocumentHidden(next));
          }}
        />
        <Text id={hintId} variant="note" tone="muted">
          The note is still there and still searchable; this only removes its tab.
          {noViews
            ? ' Add a view first: with none, the Document is all this item has to show.'
            : ''}
        </Text>
      </div>

      {pending ? (
        <Text variant="note" tone="muted" role="status">
          Saving…
        </Text>
      ) : null}
      {error === null ? null : (
        <Text variant="bodySmall" role="alert" className="border border-foreground px-3 py-2">
          {error}
        </Text>
      )}
    </section>
  );
}
