import type { SitePage } from '@nix/api-client';
import { Button, Input, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

// Module-level so its identity is stable and React calls it only when the input mounts.
function focusOnMount(node: HTMLInputElement | null): void {
  node?.focus();
}

/**
 * The site's page paths. Setting a path pins it, so a later publish never re-derives it, and the
 * old path keeps working as a permanent redirect.
 */
export function SitePagesList({
  listPages,
  setPath,
  canManage,
}: {
  readonly listPages: () => Promise<readonly SitePage[]>;
  readonly setPath: (itemId: string, path: string) => Promise<string | null>;
  readonly canManage: boolean;
}): ReactNode {
  const [pages, setPages] = useState<readonly SitePage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<{ itemId: string; path: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The page whose Change button takes focus back after its edit closes.
  const [returnFocusTo, setReturnFocusTo] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listPages()
      .then((loaded) => {
        if (!live) return;
        setError(null);
        setPages(loaded);
      })
      .catch(() => {
        if (live) setError('The page paths could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [attempt, listPages]);

  async function save(itemId: string, path: string): Promise<void> {
    setSaving(true);
    setSaveError(null);
    const refusal = await setPath(itemId, path);
    setSaving(false);
    if (refusal !== null) {
      setSaveError(refusal);
      return;
    }
    setReturnFocusTo(itemId);
    setEditing(null);
    setAttempt((value) => value + 1);
  }

  if (error !== null)
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <Text variant="note">{error}</Text>
        <Button
          variant="secondary"
          onClick={() => {
            setAttempt((value) => value + 1);
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (pages === null)
    return (
      <Text variant="note" tone="muted" role="status">
        Loading page paths…
      </Text>
    );
  if (pages.length === 0)
    return (
      <Text variant="note" tone="muted" role="status">
        No pages yet. Paths are chosen the first time the site is published.
      </Text>
    );

  return (
    <ul className="flex flex-col gap-2" aria-label="Page paths">
      {pages.map((page) => {
        const title = page.title ?? 'Untitled';
        const isEditing = editing?.itemId === page.itemId;
        return (
          <li key={page.itemId} className="flex flex-col gap-1">
            <Text variant="note" as="span">
              {title}
            </Text>
            {isEditing ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(page.itemId, editing.path);
                }}
              >
                <Input
                  ref={focusOnMount}
                  aria-label={`Path for ${title}`}
                  aria-describedby={`${page.itemId}-path-hint`}
                  value={editing.path}
                  onChange={(event) => {
                    setEditing({ itemId: page.itemId, path: event.currentTarget.value });
                  }}
                />
                <Text id={`${page.itemId}-path-hint`} variant="note" tone="muted">
                  {`The old path, ${page.path}, keeps redirecting to the new one.`}
                </Text>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setReturnFocusTo(page.itemId);
                      setEditing(null);
                      setSaveError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={saving}>
                    Save path
                  </Button>
                </div>
                {saveError === null ? null : (
                  <Text role="alert" variant="note">
                    {saveError}
                  </Text>
                )}
              </form>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <Text variant="note" as="span" tone="muted">
                  {page.pinned ? `${page.path} (pinned)` : page.path}
                </Text>
                {canManage && page.path !== '/' ? (
                  <Button
                    ref={(node: HTMLButtonElement | null) => {
                      if (node === null || returnFocusTo !== page.itemId) return;
                      setReturnFocusTo(null);
                      node.focus();
                    }}
                    variant="ghost"
                    aria-label={`Change the path of ${title}`}
                    onClick={() => {
                      setSaveError(null);
                      setEditing({ itemId: page.itemId, path: page.path });
                    }}
                  >
                    Change
                  </Button>
                ) : null}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
