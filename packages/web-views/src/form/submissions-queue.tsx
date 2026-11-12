import { Button, Select, Text, useUndo } from '@nix/ui';
import type { Item, PropertyDefinition } from '@nix/web-collections/core/container-model';
import { ensureWorkflowFields } from '@nix/web-collections/core/workflow-fields';
import { useItemDialog } from '@nix/web-foundation/lib/item-dialog-context';
import { useState, type ReactNode } from 'react';
import { resolveLoadState } from '../core/view-chrome';
import type { ViewRendererProps } from '../core/view-kinds';
import {
  FORM_SOURCE,
  SUBMISSION_ASSIGNEE,
  SUBMISSION_COMPLETION,
  SUBMISSION_STATUS,
} from './submission-fields';

const REVIEW_FIELDS = [FORM_SOURCE, SUBMISSION_STATUS, SUBMISSION_ASSIGNEE];

function statusOf(item: Item): string {
  const value = item.properties[SUBMISSION_STATUS.key];
  return typeof value === 'string' && SUBMISSION_STATUS.options.includes(value) ? value : 'New';
}

export function SubmissionsQueue({ container, view, onOpen }: ViewRendererProps): ReactNode {
  const openDialog = useItemDialog();
  const undo = useUndo();
  const [filter, setFilter] = useState('all');
  const [showOlder, setShowOlder] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );
  const entries = container.children.filter((item) => item.properties[FORM_SOURCE.key] === view.id);
  const older = container.children.filter((item) => item.properties[FORM_SOURCE.key] == null);
  const shown = entries.filter((item) => filter === 'all' || statusOf(item) === filter);
  const inputFields =
    view.interactiveForm?.pages.flatMap((page) =>
      page.blocks.flatMap((block) => block.propertyKey ?? []),
    ) ?? view.columns;
  const tracking =
    container.schema?.properties.some(
      (property) => property.key === FORM_SOURCE.key && property.type === 'text',
    ) === true;

  async function enableTracking(): Promise<void> {
    setPending(true);
    const refusal = await ensureWorkflowFields(container, [FORM_SOURCE]);
    setMessage({
      text: refusal ?? 'New public responses will appear here.',
      error: refusal !== null,
    });
    setPending(false);
  }

  async function change(
    item: Item,
    fields: readonly PropertyDefinition[],
    changes: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    setPending(true);
    setMessage(null);
    const before = Object.fromEntries(
      Object.keys(changes).map((key) => [key, item.properties[key] ?? null]),
    );
    const setup = await ensureWorkflowFields(container, fields);
    const refusal = setup ?? (await container.setProperties(item.id, changes));
    if (refusal === null) {
      undo.push(label, async () => {
        const problem = await container.setProperties(item.id, before);
        if (problem !== null) throw new Error(problem);
      });
    }
    setMessage({ text: refusal ?? label, error: refusal !== null });
    setPending(false);
  }

  async function review(item: Item): Promise<void> {
    if (openDialog === null) {
      onOpen(item.id);
      return;
    }
    setPending(true);
    setMessage(null);
    const refusal = await ensureWorkflowFields(container, REVIEW_FIELDS);
    setPending(false);
    if (refusal !== null) {
      setMessage({ text: refusal, error: true });
      return;
    }
    const responseFields = inputFields.some((key) => key !== 'title')
      ? inputFields
      : (container.schema?.properties ?? [])
          .filter((property) => property.key !== FORM_SOURCE.key)
          .map((property) => property.key);
    openDialog(item.id, {
      kind: 'record',
      fields: [
        ...new Set([
          SUBMISSION_ASSIGNEE.key,
          SUBMISSION_STATUS.key,
          ...responseFields,
          SUBMISSION_COMPLETION.key,
        ]),
      ],
      rows: shown.map((row) => row.id),
    });
  }

  if (
    container.status === 'error' ||
    (container.status === 'loading' && container.children.length === 0)
  ) {
    return resolveLoadState(container, 'submissions');
  }

  return (
    <section aria-label="Submissions" aria-busy={pending} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text as="h2" variant="h5">
          Submissions
        </Text>
        <Select
          aria-label="Filter submissions"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        >
          <option value="all">All statuses</option>
          {SUBMISSION_STATUS.options.map((status) => (
            <option key={status}>{status}</option>
          ))}
        </Select>
      </div>
      {message === null ? null : (
        <Text variant="note" role={message.error ? 'alert' : 'status'}>
          {message.text}
        </Text>
      )}
      {view.kind === 'interactive_form' && !tracking ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={pending}
          onClick={() => void enableTracking()}
        >
          Track public submissions
        </Button>
      ) : null}
      {container.status === 'partial' ? (
        <Text role="status" variant="note">
          Only loaded submissions are shown.
        </Text>
      ) : null}
      {shown.length === 0 ? (
        <Text variant="note" tone="muted">
          {entries.length === 0 ? 'No submissions yet.' : 'No submissions match this status.'}
        </Text>
      ) : (
        <ul className="flex flex-col divide-y divide-divider">
          {shown.map((item) => {
            const status = statusOf(item);
            const title = item.title || 'Untitled';
            const task = typeof item.properties[SUBMISSION_COMPLETION.key] === 'boolean';
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-2 py-2">
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start text-left"
                  disabled={pending}
                  onClick={() => void review(item)}
                >
                  {title}
                </Button>
                <Select
                  aria-label={`Review status for ${title}`}
                  disabled={pending}
                  value={status}
                  onChange={(event) => {
                    const next = event.target.value;
                    void change(
                      item,
                      [SUBMISSION_STATUS],
                      { [SUBMISSION_STATUS.key]: next },
                      `Marked ${title} ${next.toLowerCase()}`,
                    );
                  }}
                >
                  {SUBMISSION_STATUS.options.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  disabled={pending || task}
                  aria-label={task ? `${title} is a task` : `Turn ${title} into a task`}
                  onClick={() =>
                    void change(
                      item,
                      [SUBMISSION_STATUS, SUBMISSION_COMPLETION],
                      {
                        [SUBMISSION_STATUS.key]: 'Follow-up',
                        [SUBMISSION_COMPLETION.key]: false,
                      },
                      `Turned ${title} into a task`,
                    )
                  }
                >
                  {task ? 'Task' : 'Turn into task'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {older.length === 0 ? null : (
        <div className="flex flex-col items-start gap-2 border-t border-divider p-3">
          <Button
            variant="subtle"
            aria-expanded={showOlder}
            onClick={() => {
              setShowOlder(!showOlder);
            }}
          >
            {showOlder
              ? 'Hide earlier entries'
              : `Browse earlier entries (${String(older.length)})`}
          </Button>
          {showOlder ? (
            <>
              <Text variant="note" tone="muted">
                Add any earlier responses that belong to this form.
              </Text>
              <ul className="w-full">
                {older.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2">
                    <Text variant="bodySmall" truncate>
                      {item.title || 'Untitled'}
                    </Text>
                    <Button
                      variant="secondary"
                      disabled={pending}
                      aria-label={`Add ${item.title || 'Untitled'} to submissions`}
                      onClick={() =>
                        void change(
                          item,
                          [FORM_SOURCE],
                          { [FORM_SOURCE.key]: view.id },
                          'Added to submissions',
                        )
                      }
                    >
                      Add to submissions
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
