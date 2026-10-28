import { Button, Checkbox, Dialog, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { CHILD_LIMIT, type ChildChoice } from './use-item-site';

/**
 * Which items inside the site are left out. Leaving an item out leaves out everything inside it.
 * The picker walks the tree one level at a time from the site's root, so a large site never loads
 * all of its descendants just to toggle one.
 */
export function SiteExclusionsPicker({
  open,
  rootItemId,
  rootTitle,
  excluded,
  listChildren,
  onSave,
  onClose,
}: {
  readonly open: boolean;
  readonly rootItemId: string;
  readonly rootTitle: string;
  readonly excluded: readonly string[];
  readonly listChildren: (parentId: string) => Promise<readonly ChildChoice[]>;
  readonly onSave: (excludedItemIds: readonly string[]) => Promise<string | null>;
  readonly onClose: () => void;
}): ReactNode {
  const [trail, setTrail] = useState<readonly { id: string; title: string }[]>([
    { id: rootItemId, title: rootTitle },
  ]);
  const [children, setChildren] = useState<readonly ChildChoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(excluded));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when somebody moves between levels, so the new current breadcrumb takes focus; the
  // control they pressed may no longer exist.
  const [moved, setMoved] = useState(false);
  const parentId = trail.at(-1)?.id ?? rootItemId;

  useEffect(() => {
    if (!open) return;
    let live = true;
    listChildren(parentId)
      .then((loaded) => {
        if (!live) return;
        setLoadError(null);
        setChildren(loaded);
      })
      .catch(() => {
        if (live) setLoadError('These items could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [attempt, listChildren, open, parentId]);

  function toggle(id: string, on: boolean): void {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  }

  function enter(next: readonly { id: string; title: string }[]): void {
    setChildren(null);
    setTrail(next);
    setMoved(true);
  }

  function focusCurrent(node: HTMLButtonElement | null): void {
    if (node === null || !moved) return;
    setMoved(false);
    node.focus();
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    const refusal = await onSave([...chosen]);
    setSaving(false);
    if (refusal === null) onClose();
    else setError(refusal);
  }

  return (
    <Dialog
      open={open}
      title="Leave items out of the site"
      onClose={onClose}
      dirty={chosen.size !== excluded.length || excluded.some((id) => !chosen.has(id))}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() => {
              void save();
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Text variant="note" tone="muted">
          A left-out item, and everything inside it, is not published. The change reaches the live
          site with the next publish.
        </Text>
        <nav aria-label="Where you are in the site" className="flex flex-wrap items-center gap-1">
          {trail.map((step, index) => (
            <Button
              key={step.id}
              variant="ghost"
              aria-current={index === trail.length - 1 ? 'location' : undefined}
              {...(index === trail.length - 1 ? { ref: focusCurrent } : {})}
              onClick={() => {
                enter(trail.slice(0, index + 1));
              }}
            >
              {step.title === '' ? 'Untitled' : step.title}
            </Button>
          ))}
        </nav>
        {loadError !== null ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <Text variant="note">{loadError}</Text>
            <Button
              variant="secondary"
              onClick={() => {
                setAttempt((value) => value + 1);
              }}
            >
              Retry
            </Button>
          </div>
        ) : children === null ? (
          <Text variant="note" tone="muted" role="status">
            Loading…
          </Text>
        ) : children.length === 0 ? (
          <Text variant="note" tone="muted" role="status">
            Nothing inside this item.
          </Text>
        ) : (
          <>
            {children.length >= CHILD_LIMIT ? (
              <Text variant="note" tone="muted">
                {`Showing the first ${String(CHILD_LIMIT)} items at this level.`}
              </Text>
            ) : null}
            <ul className="flex flex-col gap-1" aria-label="Items">
              {children.map((child) => {
                const title = child.title === '' ? 'Untitled' : child.title;
                return (
                  <li key={child.id} className="flex items-center justify-between gap-2">
                    <Checkbox
                      label={`Leave out ${title}`}
                      checked={chosen.has(child.id)}
                      onChange={(event) => {
                        toggle(child.id, event.currentTarget.checked);
                      }}
                    />
                    {child.hasChildren && !chosen.has(child.id) ? (
                      <Button
                        variant="ghost"
                        aria-label={`Show what is inside ${title}`}
                        onClick={() => {
                          enter([...trail, { id: child.id, title }]);
                        }}
                      >
                        Open
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
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
