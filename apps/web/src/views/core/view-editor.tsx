import { Button, Field, Icon, Select, Text } from '@nix/ui';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { Suspense, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { STRUCTURED_RECIPES } from '@nix/structure-spec';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { uniqueIdentifier, type View } from './container-model';
import { EditorShell } from './editor-shell';
import type { ContainerData } from './use-container';
import { viewConfigureHref } from './view-configure-route';
import { OpensAsSection } from './opens-as-section';
import { ProgramEditorSlot, starterProgram } from './program-editor-slot';
import { findViewKind } from './view-kinds';

/** A custom view with the starter program, which lists the collection's children. */
function newCustomView(taken: ReadonlySet<string>): View {
  return {
    id: uniqueIdentifier('custom', taken),
    name: 'Custom',
    kind: 'custom',
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
    program: starterProgram(),
  };
}

/**
 * Adding and configuring the ways a folder can be looked at.
 *
 * **Order is part of what is being edited**, which is why this saves the whole set rather than one
 * view at a time: a switcher's entries get dragged into an order about as often as an individual
 * view gets renamed, and per-view saves would make a reorder a sequence of writes that can
 * half-apply.
 *
 * The configuration a view needs depends on its kind, and only the fields that apply are shown. A
 * board offered a date property, or a calendar offered a grouping property, would be an invitation
 * to configure something the renderer ignores.
 */

export interface ViewEditorProps {
  readonly container: ContainerData;
  readonly open: boolean;
  readonly onClose: () => void;

  /** Renders as a column in the settings panel rather than as a dialog over the view. */
  readonly inline?: boolean;
}

export function ViewEditor({
  container,
  open,
  onClose,
  inline = false,
}: ViewEditorProps): ReactNode {
  const stored = container.views?.views ?? [];
  const [draft, setDraft] = useState<readonly View[]>(stored);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [programOf, setProgramOf] = useState<string | null>(null);
  const workspaceId = useOptionalWorkspace()?.workspaceId ?? '';
  const navigate = useNavigate();

  const [openedWith, setOpenedWith] = useState(open);
  if (open !== openedWith) {
    setOpenedWith(open);
    if (open) {
      setDraft(stored);
      setError(null);
    }
  }

  function move(index: number, by: number): void {
    setDraft((current) => {
      const next = [...current];
      const target = index + by;
      const moved = next[index];
      const displaced = next[target];

      if (moved === undefined || displaced === undefined) {
        return current;
      }

      next[index] = displaced;
      next[target] = moved;
      return next;
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);

    // **The first view an item is given becomes what it opens on.** Building a board and watching
    // the screen not change is the whole of the bug this exists to prevent: the item kept opening
    // on its document, because that is what it had always said, and the person had no reason to
    // suspect a switcher had appeared above the thing they were already looking at.
    //
    // Only the first. Once an item offers views, "document" is a choice somebody can have made
    // deliberately, and adding a second view must not overrule it.
    const first = stored.length === 0 && draft.length > 0 ? draft[0]?.id : undefined;

    const refusal =
      first === undefined
        ? await container.setViews(draft)
        : await container.setViews(draft, first);

    setSaving(false);

    if (refusal === null) {
      onClose();
      return;
    }

    setError(refusal);
  }

  return (
    <EditorShell
      inline={inline}
      open={open}
      title="Views for this item"
      onClose={onClose}
      onSave={() => {
        void save();
      }}
      saving={saving}
      saveLabel="Save views"
    >
      <div className="flex flex-col gap-4">
        <Text variant="bodySmall" tone="muted">
          A view is a way of looking at this item. Everybody who can see it sees the same views.
        </Text>

        <OpensAsSection container={container} />

        {error === null ? null : (
          <Text variant="bodySmall" role="alert" className="border border-foreground px-3 py-2">
            {error}
          </Text>
        )}

        {draft.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            No child-item views yet. The item still opens its document.
          </Text>
        ) : null}

        {draft.map((view, index) => (
          <div key={view.id} className="flex flex-col gap-2 border border-divider p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1 basis-full">
                <Text variant="bodySmall" className="truncate">
                  {view.name}
                </Text>
                <Text variant="caption" tone="muted">
                  {findViewKind(view.kind)?.label ?? view.kind}
                  {view.companionViewId === null ? '' : ' · Has companion'}
                </Text>
              </div>

              <Button
                variant="secondary"
                disabled={viewConfigureHref(container.itemId, view) === null}
                onClick={() => {
                  const href = viewConfigureHref(container.itemId, view);
                  if (href !== null) {
                    void navigate(href);
                  }
                }}
              >
                Configure
              </Button>

              {view.kind === 'custom' ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setProgramOf(programOf === view.id ? null : view.id);
                  }}
                >
                  {programOf === view.id ? 'Close program' : 'Edit program'}
                </Button>
              ) : null}

              <Button
                variant="icon"
                aria-label={`Move ${view.name} earlier`}
                disabled={index === 0}
                onClick={() => {
                  move(index, -1);
                }}
              >
                <Icon icon={ChevronUp} size="sm" />
              </Button>

              <Button
                variant="icon"
                aria-label={`Move ${view.name} later`}
                disabled={index === draft.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
              >
                <Icon icon={ChevronDown} size="sm" />
              </Button>

              <Button
                variant="icon"
                aria-label={`Remove ${view.name}`}
                onClick={() => {
                  setDraft((current) =>
                    current
                      .filter((_, position) => position !== index)
                      .map((candidate) =>
                        candidate.companionViewId === view.id
                          ? {
                              ...candidate,
                              companionViewId: null,
                              companionPlacement: null,
                            }
                          : candidate,
                      ),
                  );
                }}
              >
                <Icon icon={Trash2} size="sm" />
              </Button>
            </div>
            {view.kind === 'custom' && programOf === view.id ? (
              <Suspense fallback={<Text role="status">Loading the editor…</Text>}>
                <ProgramEditorSlot
                  value={view.program ?? ''}
                  workspaceId={workspaceId}
                  label={`Program for ${view.name}`}
                  containerId={container.itemId}
                  onChange={(program) => {
                    setDraft((current) =>
                      current.map((candidate) =>
                        candidate.id === view.id ? { ...candidate, program } : candidate,
                      ),
                    );
                  }}
                />
              </Suspense>
            ) : null}
          </div>
        ))}

        <Button
          variant="secondary"
          onClick={() => {
            setAdding((current) => !current);
          }}
        >
          <Icon icon={Plus} size="sm" />
          {adding ? 'Close view choices' : 'Add a view'}
        </Button>
        {adding ? (
          <Field label="View type">
            {(control) => (
              <Select
                {...control}
                value=""
                disabled={container.itemId === null}
                onChange={(event) => {
                  if (event.target.value === 'custom') {
                    const view = newCustomView(new Set(draft.map((candidate) => candidate.id)));
                    setDraft([...draft, view]);
                    setProgramOf(view.id);
                    setAdding(false);
                    return;
                  }
                  const recipe = STRUCTURED_RECIPES.find(
                    (entry) => entry.id === event.target.value,
                  );
                  if (container.itemId !== null && recipe !== undefined) {
                    void navigate(`/items/${container.itemId}/views/new/${recipe.id}`);
                  }
                }}
              >
                <option value="">Choose a view type</option>
                <option value="custom">Custom (a program)</option>
                {STRUCTURED_RECIPES.filter(
                  (recipe, index, all) =>
                    all.findIndex((candidate) => candidate.viewKind === recipe.viewKind) === index,
                ).map((recipe) => (
                  <option key={recipe.id} value={recipe.id}>
                    {recipe.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>
    </EditorShell>
  );
}
