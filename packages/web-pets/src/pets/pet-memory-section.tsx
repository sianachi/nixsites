import type { PetSettings } from '@nix/api-client';
import { Button, Checkbox, Field, Input, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';

type Memory = NonNullable<PetSettings['memories']>[number];

/** Core refuses more than this many memories, or a longer one. */
const MAX_MEMORIES = 50;
const MAX_LENGTH = 280;

/**
 * What the pet has learned about the owner. Every entry goes to the model with each new
 * conversation, so the owner can correct or remove any of them here; edits save with the form.
 */
export function PetMemorySection({
  memories,
  memoryOff,
  onChange,
}: {
  readonly memories: readonly Memory[];
  readonly memoryOff: boolean;
  readonly onChange: (memories: Memory[], memoryOff: boolean) => void;
}): ReactElement {
  const [adding, setAdding] = useState('');
  const full = memories.length >= MAX_MEMORIES;

  function add(): void {
    const text = adding.trim();
    if (!text || full) return;
    onChange(
      [...memories, { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }],
      memoryOff,
    );
    setAdding('');
  }

  return (
    <section aria-labelledby="pet-memory-heading" className="flex min-w-0 flex-col gap-3">
      <Text as="h3" id="pet-memory-heading" variant="h5">
        Memory
      </Text>
      <div className="flex flex-col gap-1">
        <Checkbox
          label="Let pets remember things about you"
          checked={!memoryOff}
          onChange={(event) => {
            onChange([...memories], !event.currentTarget.checked);
          }}
        />
        <Text variant="note" tone="muted">
          Pets save facts you tell them about yourself and send them with each new conversation.
          Turning this off stops both; what is listed stays until you remove it.
        </Text>
      </div>
      {memories.length === 0 ? (
        <Text variant="note" tone="muted">
          Nothing remembered yet.
        </Text>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2" aria-label="Remembered facts">
          {memories.map((memory, index) => (
            <li key={memory.id} className="flex min-w-0 items-center gap-2">
              <Input
                aria-label={`Memory ${String(index + 1)}`}
                className="min-w-0 flex-1"
                maxLength={MAX_LENGTH}
                value={memory.text}
                onChange={(event) => {
                  const text = event.currentTarget.value;
                  onChange(
                    memories.map((entry) => (entry.id === memory.id ? { ...entry, text } : entry)),
                    memoryOff,
                  );
                }}
              />
              <Button
                variant="ghost"
                aria-label={`Forget "${memory.text}"`}
                onClick={() => {
                  onChange(
                    memories.filter((entry) => entry.id !== memory.id),
                    memoryOff,
                  );
                }}
              >
                Forget
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <Field
          label="Add something to remember"
          {...(full ? { hint: `Full: ${String(MAX_MEMORIES)} facts at most` } : {})}
          className="min-w-0 flex-1"
        >
          {(control) => (
            <Input
              {...control}
              maxLength={MAX_LENGTH}
              disabled={full}
              value={adding}
              onChange={(event) => {
                setAdding(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                add();
              }}
            />
          )}
        </Field>
        <Button variant="secondary" disabled={full || !adding.trim()} onClick={add}>
          Add
        </Button>
      </div>
    </section>
  );
}
