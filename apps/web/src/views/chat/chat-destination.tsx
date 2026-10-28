import { items, type Item } from '@nix/api-client';
import { Button, Select, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';

export function ChatDestination({
  workspaceId,
  parentId,
  onChange,
}: {
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly onChange: (id: string | null) => void;
}): ReactNode {
  const client = useApiClient();
  const [choices, setChoices] = useState<readonly Item[]>([]);
  const [parentTitle, setParentTitle] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setError('');
        setChoices([]);
      }
    });
    if (!workspaceId)
      return () => {
        controller.abort();
      };
    void (async () => {
      if (parentId) {
        const parent = await client.query(items.itemById(parentId), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (parent.workspaceId !== workspaceId)
          throw new Error('Destination belongs to another workspace.');
        if (!controller.signal.aborted) setParentTitle(parent.title || 'Untitled note');
      }
      const found: Item[] = [];
      for await (const page of client.paginate(
        items.listItems(workspaceId, parentId ? { parentId } : {}),
        { signal: controller.signal },
      ))
        found.push(page);
      if (!controller.signal.aborted) setChoices(found);
    })().catch(() => {
      if (!controller.signal.aborted) setError('Destination notes could not be loaded.');
    });
    return () => {
      controller.abort();
    };
  }, [client, workspaceId, parentId]);
  return (
    <div className="flex flex-col gap-2">
      <Text variant="note">
        {parentId
          ? `Save inside ${parentTitle || 'the selected note'}. Choose a child to navigate further.`
          : 'Save at the workspace root, or choose a parent note.'}
      </Text>
      {parentId ? (
        <Button
          variant="secondary"
          onClick={() => {
            onChange(null);
          }}
        >
          Use workspace root
        </Button>
      ) : null}
      <Select
        aria-label="Destination parent note"
        value=""
        onChange={(event) => {
          if (event.currentTarget.value) onChange(event.currentTarget.value);
        }}
      >
        <option value="">{parentId ? parentTitle || 'Selected note' : 'Workspace root'}</option>
        {choices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title || 'Untitled note'}
          </option>
        ))}
      </Select>
      {error ? <Text role="alert">{error}</Text> : null}
    </div>
  );
}
