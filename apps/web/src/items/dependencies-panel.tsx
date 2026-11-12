import { Button, Input, Select, Text } from '@nix/ui';
import { dayFromText, dayLabel } from '@nix/web-collections/core/calendar-dates';
import { useContainer } from '@nix/web-collections/core/use-container';
import { ensureWorkflowFields } from '@nix/web-collections/core/workflow-fields';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import type { ItemProperties } from '@nix/web-collections/properties/use-item-properties';
import type { ItemDialogContextView } from '@nix/web-foundation/lib/item-dialog-context';
import { useState, type ReactNode } from 'react';
import { useContextWrite } from './context-fields';
import {
  DEPENDENCY_KEY,
  dependsOn,
  prerequisites,
  previewDependencyDates,
  scheduledDay,
} from './dependency-dates';

function displayDay(value: string): string {
  const day = dayFromText(value);
  return day === null ? value : dayLabel(day);
}

export function DependenciesPanel({
  details,
  view,
  onOpen,
}: {
  readonly details: ItemProperties;
  readonly view: Extract<ItemDialogContextView, { kind: 'dependencies' }>;
  readonly onOpen: (id: string) => void;
}): ReactNode {
  const container = useContainer(view.containerId);
  const { hiddenSet } = useHiddenItems();
  const write = useContextWrite(details);
  const [selection, setSelection] = useState('');
  const [draftStart, setDraftStart] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const item = details.item;
  if (details.error !== null || container.status === 'error') {
    return (
      <Text role="alert" variant="note">
        {details.error ?? container.error ?? 'Dependencies could not be loaded.'}
      </Text>
    );
  }
  if (container.locked)
    return <Text variant="note">Unlock the timeline to see its dependencies.</Text>;
  if (item === null || container.status === 'loading') {
    return (
      <Text role="status" variant="note">
        Loading dependencies…
      </Text>
    );
  }
  const items = container.children.filter((child) => child.id !== item.id).concat(item);
  const byId = new Map(items.map((child) => [child.id, child]));
  const linked = prerequisites(item);
  const eligible = items.filter(
    (child) =>
      !hiddenSet.has(child.id) && !linked.includes(child.id) && !dependsOn(child.id, item.id, byId),
  );
  const dependent = items.filter(
    (child) =>
      child.id !== item.id && !hiddenSet.has(child.id) && prerequisites(child).includes(item.id),
  );
  const currentStart = scheduledDay(item, view.startKey);
  const preview =
    draftStart === ''
      ? []
      : previewDependencyDates(item.id, draftStart, items, view.startKey, view.endKey).filter(
          (entry) => !hiddenSet.has(entry.item.id),
        );

  async function save(ids: readonly string[]): Promise<void> {
    setSaving(true);
    setProblem(null);
    const refusal = await ensureWorkflowFields(container, [
      { key: DEPENDENCY_KEY, label: 'Depends on', type: 'long_text', options: [], required: false },
    ]);
    const result =
      refusal ?? (await write({ [DEPENDENCY_KEY]: ids.length === 0 ? null : ids.join('\n') }));
    setSaving(false);
    setProblem(result);
    if (result === null) setSelection('');
  }

  return (
    <>
      <div className="flex flex-col items-start gap-2">
        <Text as="h3" variant="h6">
          Depends on
        </Text>
        {linked.length === 0 ? (
          <Text variant="note" tone="muted">
            No prerequisites.
          </Text>
        ) : (
          <ul className="w-full">
            {linked.map((id) => {
              const dependency = byId.get(id);
              const title =
                dependency === undefined || hiddenSet.has(id)
                  ? null
                  : dependency.title || 'Untitled';
              return (
                <li key={id} className="flex items-center justify-between gap-2">
                  {title === null ? (
                    <Text variant="note">Unavailable item</Text>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        onOpen(id);
                      }}
                    >
                      {title}
                    </Button>
                  )}
                  <Button
                    variant="subtle"
                    disabled={saving}
                    aria-label={`Remove ${title ?? 'unavailable item'} as prerequisite`}
                    onClick={() => void save(linked.filter((key) => key !== id))}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex w-full flex-wrap items-center gap-2">
          <Select
            aria-label="Prerequisite"
            className="min-w-0 flex-1"
            value={selection}
            onChange={(event) => {
              setSelection(event.target.value);
            }}
          >
            <option value="">Choose a prerequisite</option>
            {eligible.map((child) => (
              <option key={child.id} value={child.id}>
                {child.title || 'Untitled'}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            disabled={saving || !eligible.some((child) => child.id === selection)}
            onClick={() => void save([...linked, selection])}
          >
            {saving ? 'Saving…' : 'Add dependency'}
          </Button>
        </div>
        {problem === null ? null : (
          <Text role="alert" variant="note">
            {problem}
          </Text>
        )}
      </div>
      <div className="flex flex-col items-start gap-2">
        <Text as="h3" variant="h6">
          Needed by
        </Text>
        {dependent.length === 0 ? (
          <Text variant="note" tone="muted">
            No dependent items.
          </Text>
        ) : (
          <ul>
            {dependent.map((child) => (
              <li key={child.id}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    onOpen(child.id);
                  }}
                >
                  {child.title || 'Untitled'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {currentStart === null ? null : (
        <div className="flex flex-col items-start gap-2 border-t border-divider p-3">
          <Text as="h3" variant="h6">
            Preview a new start date
          </Text>
          <Input
            type="date"
            aria-label="Proposed start date"
            value={draftStart}
            onChange={(event) => {
              setDraftStart(event.target.value);
            }}
          />
          {draftStart === '' ? null : (
            <>
              <Text variant="note" tone="muted">
                Suggested changes for dated items in this timeline. No dates are saved.
              </Text>
              {preview.length === 0 ? (
                <Text variant="note" role="status">
                  No dates would change.
                </Text>
              ) : (
                <ul>
                  {preview.map(({ item: child, before, after }) => (
                    <Text key={child.id} as="li" variant="bodySmall">
                      {child.title || 'Untitled'}: {displayDay(before)} → {displayDay(after)}
                    </Text>
                  ))}
                </ul>
              )}
            </>
          )}
          {container.status === 'partial' ? (
            <Text role="status" variant="note">
              Only loaded items are included.
            </Text>
          ) : null}
        </div>
      )}
    </>
  );
}
