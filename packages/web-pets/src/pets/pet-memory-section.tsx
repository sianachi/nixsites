import type { PetSettings } from '@nix/api-client';
import { Button, Field, Input, Select, Text } from '@nix/ui';
import type { PetMemoryMode } from './memory-mode';
import { useState, type ReactElement } from 'react';

type Memory = NonNullable<PetSettings['memories']>[number];

const MODE_HINTS: Record<PetMemoryMode, string> = {
  off: 'Nothing listed here is sent to your pets, and they save nothing new.',
  ask: 'Each new fact waits for your approval in the chat. What is listed is sent with each new conversation.',
  always:
    'Pets save facts you tell them without asking, each with Undo. What is listed is sent with each new conversation.',
};

/** Core refuses more than this many memories, or a longer one. */
const MAX_MEMORIES = 50;
const MAX_LENGTH = 280;

/**
 * What the pet has learned about the owner. Every entry goes to the model with each new
 * conversation, so the owner can correct or remove any of them here; edits save with the form.
 */
export function PetMemorySection({
  memories,
  mode,
  onChange,
}: {
  readonly memories: readonly Memory[];
  readonly mode: PetMemoryMode;
  readonly onChange: (memories: Memory[], mode: PetMemoryMode) => void;
}): ReactElement {
  const [adding, setAdding] = useState('');
  const full = memories.length >= MAX_MEMORIES;

  function add(): void {
    const text = adding.trim();
    if (!text || full) return;
    onChange(
      [...memories, { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }],
      mode,
    );
    setAdding('');
  }

  return (
    <section aria-labelledby="pet-memory-heading" className="flex min-w-0 flex-col gap-3">
      <Text as="h3" id="pet-memory-heading" variant="h5">
        Memory
      </Text>
      <Field label="When a pet learns something about you" hint={MODE_HINTS[mode]}>
        {(control) => (
          <Select
            {...control}
            value={mode}
            onChange={(event) => {
              onChange([...memories], event.currentTarget.value as PetMemoryMode);
            }}
          >
            <option value="off">Don't remember</option>
            <option value="ask">Ask before remembering</option>
            <option value="always">Remember automatically</option>
          </Select>
        )}
      </Field>
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
                    mode,
                  );
                }}
              />
              <Button
                variant="ghost"
                aria-label={`Forget "${memory.text}"`}
                onClick={() => {
                  onChange(
                    memories.filter((entry) => entry.id !== memory.id),
                    mode,
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
