import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { files, items, search, type SearchResults } from '@nix/api-client';
import { Button, Checkbox, Dialog, Field, Input, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApiClient } from '../api/api-client-provider';
import { useSelectedItem } from '../routing/selected-item';

export type ItemInsertKind = 'attachment' | 'embed' | 'subpage' | 'image';
export function ItemInsertDialog({
  kind,
  workspaceId,
  parentId,
  onCancel,
  onInsert,
  onFiles,
}: {
  readonly kind: ItemInsertKind;
  readonly workspaceId: string;
  readonly parentId: string;
  readonly onCancel: () => void;
  readonly onInsert: (
    id: string,
    presentation: ItemInsertKind | 'inline',
    label: string,
  ) => boolean;
  readonly onFiles: (files: readonly File[]) => void;
}): ReactNode {
  const client = useApiClient();
  const { select } = useSelectedItem();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inline, setInline] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (kind === 'subpage' || query.trim().length < 3) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void client
        .query(search.searchItems(query.trim(), 100), { signal: controller.signal })
        .then((answer) => {
          if (!controller.signal.aborted) {
            setResults(answer);
            setError(null);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError('Could not search. Change the search to try again.');
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, query, kind]);
  async function createPage(): Promise<void> {
    if (query.trim().length === 0 || busy || createdId !== null) return;
    setBusy(true);
    setError(null);
    try {
      const page = await client.execute(
        items.createItem(workspaceId, { type: 'note', title: query.trim(), parentId }),
      );
      notifyItemChildrenChanged(workspaceId, parentId);
      if (!mounted.current) return;
      setCreatedId(page.id);
      if (onInsert(page.id, 'subpage', page.title)) onCancel();
      else
        setError('Your page was created, but its link could not be inserted. Open the page below.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the page. Try again.');
    } finally {
      setBusy(false);
    }
  }
  async function pick(id: string, label: string): Promise<void> {
    setError(null);
    if (kind === 'image') {
      setBusy(true);
      try {
        const file = await client.query(files.fileByItem(id));
        if (!file.current.previewable || !file.current.mediaType.startsWith('image/')) {
          setError('This file cannot be displayed as an image. Choose a supported image.');
          return;
        }
      } catch {
        setError('Could not read this image. Try again.');
        return;
      } finally {
        setBusy(false);
      }
    }
    if (!mounted.current) return;
    if (onInsert(id, inline ? 'inline' : kind, label)) onCancel();
    else setError('This item could not be inserted here.');
  }
  const current = results?.query === query.trim() ? results : null;
  const hits =
    current?.results.filter(
      (hit) =>
        hit.workspaceId === workspaceId &&
        (kind === 'embed' ? hit.type === 'note' : hit.type === 'file'),
    ) ?? [];
  return (
    <Dialog
      open
      title={
        kind === 'subpage'
          ? 'New subpage'
          : kind === 'embed'
            ? 'Embed note'
            : kind === 'image'
              ? 'Existing image'
              : 'Insert attachment'
      }
      onClose={onCancel}
      initialFocus={input}
    >
      <div className="flex flex-col gap-4">
        <Field label={kind === 'subpage' ? 'Page title' : 'Search this workspace'}>
          {(control) => (
            <Input
              {...control}
              ref={input}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>
        {kind === 'attachment' ? (
          <Field label="Upload files">
            {(control) => (
              <Input
                {...control}
                type="file"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length > 0) {
                    onFiles(files);
                    onCancel();
                  }
                }}
              />
            )}
          </Field>
        ) : null}
        {kind !== 'subpage' && kind !== 'image' ? (
          <Checkbox
            label="Insert as inline link"
            checked={inline}
            onChange={(event) => {
              setInline(event.target.checked);
            }}
          />
        ) : null}
        {error !== null ? (
          <Text variant="note" role="alert">
            {error}
          </Text>
        ) : null}
        {kind === 'subpage' ? (
          <Button
            disabled={busy || query.trim().length === 0 || createdId !== null}
            onClick={() => {
              void createPage();
            }}
          >
            {busy ? 'Creating page…' : 'Create page'}
          </Button>
        ) : (
          <>
            <div
              className="flex max-h-64 flex-col gap-2 overflow-y-auto"
              aria-label="Matching items"
            >
              {hits.map((hit) => (
                <Button
                  key={hit.id}
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    void pick(hit.id, hit.title ?? 'Untitled');
                  }}
                >
                  {hit.title ?? 'Untitled'}
                </Button>
              ))}
            </div>
            <Text variant="note" role="status">
              {query.trim().length < 3
                ? 'Type at least three letters to search.'
                : current === null
                  ? 'Searching…'
                  : hits.length === 0
                    ? current.truncated
                      ? 'No matches in these results. Refine your search to see more.'
                      : 'No matching items in this workspace.'
                    : current.truncated
                      ? 'More matches exist. Refine your search.'
                      : ''}
            </Text>
          </>
        )}
        {createdId !== null ? (
          <Button
            onClick={() => {
              select(createdId);
            }}
          >
            Open page
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
