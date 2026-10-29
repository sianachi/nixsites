import { Textarea, type TextareaProps } from '@nix/ui';
import { useState, type ReactNode } from 'react';

type Props = Omit<TextareaProps, 'value' | 'defaultValue' | 'onChange'> & {
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
};

/** Keep unfinished lines and spaces editable while publishing normalized list values. */
export function LineListInput({ value, onChange, ...props }: Props): ReactNode {
  const [draft, setDraft] = useState({ text: value.join('\n'), value });
  if (value !== draft.value) {
    const unchanged =
      value.length === draft.value.length &&
      value.every((entry, index) => entry === draft.value[index]);
    setDraft({ text: unchanged ? draft.text : value.join('\n'), value });
  }

  return (
    <Textarea
      {...props}
      value={draft.text}
      onChange={(event) => {
        const text = event.target.value;
        const next = text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        setDraft({ text, value: next });
        onChange(next);
      }}
    />
  );
}
