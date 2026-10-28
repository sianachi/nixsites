import { Button, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import type { ViewRendererProps } from '../views/core/view-kinds';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import OpenUiBlock from './openui-block';
import { ProgramEditor } from './program-editor';
import { withContainer } from './starter-program';

/**
 * A custom view: the openui-lang program stored in the view, drawn live over its collection. The
 * collection's id reaches the program as `$container` (see `withContainer`), so the program's own
 * state is untouched. Values the viewer changes are kept in this browser per view; writes always ask (no `applyWithoutAsking`), and a locked
 * collection never reaches here (the container view stops at its lock first).
 */
export default function CustomView({ container, view }: ViewRendererProps): ReactNode {
  const { workspaceId } = useWorkspace();
  const program = view.program ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(text: string): Promise<void> {
    setSaving(true);
    setError(null);
    const views = (container.views?.views ?? []).map((candidate) =>
      candidate.id === view.id ? { ...candidate, program: text } : candidate,
    );
    const refusal = await container.setViews(views);
    setSaving(false);
    if (refusal === null) setDraft(null);
    else setError(refusal);
  }

  if (draft !== null)
    return (
      <div className="flex min-w-0 flex-col gap-2 p-4">
        <ProgramEditor
          value={draft}
          onChange={setDraft}
          workspaceId={workspaceId}
          containerId={container.itemId}
          label={`Program for ${view.name}`}
        />
        {error === null ? null : <Text role="alert">{error}</Text>}
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              void save(draft);
            }}
          >
            Save program
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );

  const edit = (
    <div>
      <Button
        variant="ghost"
        onClick={() => {
          setDraft(program);
        }}
      >
        Edit program
      </Button>
    </div>
  );
  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      {program.trim() === '' ? (
        <>
          <Text variant="note">This view has no program yet.</Text>
          {edit}
        </>
      ) : (
        <>
          {edit}
          <OpenUiBlock
            // A new program is a new block: a stale parse must not outlive an edit.
            key={`${view.id}:${program}`}
            source={withContainer(program, container.itemId)}
            workspaceIds={[workspaceId]}
            stateKey={`view:${container.itemId ?? 'root'}:${view.id}`}
            fallback={
              <Text variant="note" role="alert">
                This view's program does not render. Use Edit program to fix it.
              </Text>
            }
          />
        </>
      )}
    </div>
  );
}
