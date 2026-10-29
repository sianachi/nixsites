import { Input, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The field a new item is named in. Never disabled while it saves, so focus stays for the next
 * name; a refused add puts the name back and says why.
 */
export function DraftField({
  level,
  onSubmit,
  onCancel,
}: {
  readonly level: number;
  readonly onSubmit: (title: string) => Promise<string | null>;
  readonly onCancel: () => void;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  return (
    // A row of the tree in its own right - the row being made - so the tree owns only tree items
    // while the field sits where the new item will appear.
    <div
      role="treeitem"
      tabIndex={-1}
      aria-label="New item"
      aria-level={level}
      aria-selected={false}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const named = title.trim();
          if (named.length === 0) return;
          setTitle('');
          setRefusal(null);
          void onSubmit(named).then((reason) => {
            if (reason !== null) {
              setRefusal(reason);
              setTitle(named);
            }
          });
        }}
        className="flex flex-col gap-1 py-1"
        style={{ paddingInlineStart: `min(${String((level - 1) * 1.5 + 2)}rem, 25%)` }} // design-token-exempt: tree-depth indentation is capped relative to available width so the new-item field remains reachable
      >
        <Input
          ref={fieldRef}
          aria-label="New item"
          placeholder="Name the new item"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        {refusal === null ? null : (
          <Text as="p" variant="caption" tone="accent" role="alert">
            {refusal}
          </Text>
        )}
      </form>
    </div>
  );
}
