import { Button, Icon, Input, Text } from '@nix/ui';
import { Check, IndentDecrease, IndentIncrease } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The field a new item is named in. Never disabled while it saves, so focus stays for the next
 * name; a refused add puts the name back and says why.
 */
export function DraftField({
  level,
  initialText,
  onSubmit,
  onIndent,
  onOutdent,
  onCancel,
}: {
  readonly level: number;
  readonly initialText: string;
  /** Tuck the next item under the one above / out of its parent; a refusal comes back as words. */
  readonly onIndent: (text: string) => Promise<string | null>;
  readonly onOutdent: (text: string) => string | null;
  readonly onSubmit: (title: string) => Promise<string | null>;
  readonly onCancel: () => void;
}): ReactNode {
  const [title, setTitle] = useState(initialText);
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const reshape = (run: (text: string) => Promise<string | null> | string | null): void => {
    void Promise.resolve(run(title)).then(setRefusal);
  };

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
            } else if (event.key === 'Tab') {
              event.preventDefault();
              reshape(event.shiftKey ? onOutdent : onIndent);
            }
          }}
        />
        {/* The Tab keys, for a phone: pressing them keeps the keyboard up on the field. */}
        <div className="flex flex-wrap gap-1">
          <Button
            variant="secondary"
            aria-label="Indent next item"
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              reshape(onIndent);
            }}
          >
            <Icon icon={IndentIncrease} size="sm" />
            Indent
          </Button>
          <Button
            variant="secondary"
            aria-label="Outdent next item"
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              reshape(onOutdent);
            }}
          >
            <Icon icon={IndentDecrease} size="sm" />
            Outdent
          </Button>
          <Button
            variant="secondary"
            aria-label="Done adding"
            onPointerDown={(event) => {
              event.preventDefault();
            }}
            onClick={onCancel}
          >
            <Icon icon={Check} size="sm" />
            Done
          </Button>
        </div>
        {refusal === null ? null : (
          <Text as="p" variant="caption" tone="accent" role="alert">
            {refusal}
          </Text>
        )}
      </form>
    </div>
  );
}
