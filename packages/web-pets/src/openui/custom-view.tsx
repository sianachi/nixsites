import { Button, Text, useUndo } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import type { ViewRendererProps } from '@nix/web-views/core/view-kinds';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import OpenUiBlock from './openui-block';
import { ProgramEditor } from './program-editor';
import { countChanges, plural, programChanges, type ProgramChange } from './program-changes';
import { withContainer } from './starter-program';

const VERB = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;

function ChangeList({ changes }: { readonly changes: readonly ProgramChange[] }): ReactNode {
  return (
    <ul aria-label="Changes" className="flex flex-col gap-1.5">
      {changes.map((change) => (
        <li key={change.name} className="border-l-2 border-divider pl-2 break-words">
          <Text variant="note">
            <b>{VERB[change.kind]}</b> <code className="font-mono">{change.name}</code>
          </Text>
          {change.before === undefined ? null : (
            <pre className="m-0 font-mono text-xs whitespace-pre-wrap text-muted line-through">
              {change.before}
            </pre>
          )}
          {change.after === undefined ? null : (
            <pre className="m-0 font-mono text-xs whitespace-pre-wrap">{change.after}</pre>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A custom view: the openui-lang program stored in the view, drawn live over its collection. The
 * collection's id reaches the program as `$container` (see `withContainer`), so the program's own
 * state is untouched. Values the viewer changes are kept in this browser per view; writes always ask (no `applyWithoutAsking`), and a locked
 * collection never reaches here (the container view stops at its lock first).
 */
export default function CustomView({ container, view }: ViewRendererProps): ReactNode {
  const { workspaceId } = useWorkspace();
  const undo = useUndo();
  const program = view.program ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<readonly ProgramChange[] | null>(null);

  const dirty = draft !== null && draft !== program;
  // Leaving the page with unsaved edits asks first, so they are never lost silently.
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => {
      window.removeEventListener('beforeunload', guard);
    };
  }, [dirty]);

  /** Writes a program into this view; the refusal text, or null when it was stored. */
  function store(text: string): Promise<string | null> {
    const views = (container.views?.views ?? []).map((candidate) =>
      candidate.id === view.id ? { ...candidate, program: text } : candidate,
    );
    return container.setViews(views);
  }

  async function save(text: string): Promise<void> {
    setSaving(true);
    setError(null);
    const before = program;
    const refusal = await store(text);
    setSaving(false);
    if (refusal !== null) {
      setError(refusal);
      return;
    }
    setDraft(null);
    setSaved(programChanges(before, text));
    undo.push(`Saved ${plural(countChanges(before, text))} to ${view.name}`, async () => {
      const failed = await store(before);
      if (failed === null) setSaved(null);
    });
  }

  function discard(text: string): void {
    const count = countChanges(program, text);
    setDraft(null);
    setError(null);
    if (count > 0)
      undo.push(`Discarded ${plural(count)}`, () => {
        setDraft((current) => current ?? text);
      });
  }

  if (draft !== null) {
    const changes = programChanges(program, draft);
    const count = countChanges(program, draft);
    return (
      <div className="flex min-w-0 flex-col gap-2 p-4">
        <ProgramEditor
          value={draft}
          onChange={setDraft}
          workspaceId={workspaceId}
          containerId={container.itemId}
          label={`Program for ${view.name}`}
        />
        {changes.length === 0 ? null : (
          <details className="rounded-sm border border-divider px-2.5 py-1.5">
            <summary className="flex min-h-7 cursor-pointer items-center">
              Changes since last save ({changes.length})
            </summary>
            <div className="pt-2">
              <ChangeList changes={changes} />
            </div>
          </details>
        )}
        {error === null ? null : <Text role="alert">{error}</Text>}
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-divider bg-background py-2">
          <Text variant="note" tone="muted" role="status" className="min-w-32 flex-1">
            {count === 0 ? 'No changes yet.' : `${plural(count)} not saved.`}
          </Text>
          <Button
            variant="ghost"
            onClick={() => {
              discard(draft);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={saving || count === 0}
            onClick={() => {
              void save(draft);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      <div className="sticky top-0 z-10 flex justify-end bg-background py-1">
        <Button
          variant="primary"
          onClick={() => {
            setSaved(null);
            setDraft(program);
          }}
        >
          Edit view
        </Button>
      </div>
      {saved === null ? null : (
        <div role="status" data-enter="" className="flex flex-col gap-1">
          <Text variant="note">
            {saved.length === 0 ? 'Saved. ' : `Saved ${plural(saved.length)}. `}
            <Button
              variant="ghost"
              onClick={() => {
                setSaved(null);
              }}
            >
              Dismiss
            </Button>
          </Text>
          {saved.length === 0 ? null : (
            <details className="rounded-sm border border-divider px-2.5 py-1.5">
              <summary className="flex min-h-7 cursor-pointer items-center">What changed</summary>
              <div className="pt-2">
                <ChangeList changes={saved} />
              </div>
            </details>
          )}
        </div>
      )}
      {program.trim() === '' ? (
        <Text variant="note">This view has no program yet. Use Edit view to start.</Text>
      ) : (
        <OpenUiBlock
          // A new program is a new block: a stale parse must not outlive an edit.
          key={`${view.id}:${program}`}
          source={withContainer(program, container.itemId)}
          workspaceIds={[workspaceId]}
          stateKey={`view:${container.itemId ?? 'root'}:${view.id}`}
          fallback={
            <Text variant="note" role="alert">
              This view's program does not render. Use Edit view to fix it.
            </Text>
          }
        />
      )}
    </div>
  );
}
