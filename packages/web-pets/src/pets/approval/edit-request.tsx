import { workspaceToolSchema, type WorkspaceToolArgs } from '@nix/companion/tool-args';
import { Button, Text } from '@nix/ui';
import { BuiltinActionType, Renderer, type ActionEvent } from '@openuidev/react-lang';
import { useRef, useState, type ReactNode } from 'react';

import { nixLibrary } from '../../openui/library';

/** An owner's correction to a write before approving it: what runs instead, and the sentence the
 * pet is told so its picture of what happened stays true. */
export interface EditedRequest {
  readonly arguments: string;
  readonly note: string;
}

type Value = string | number | boolean;

/** One editable value: where it sits in the request, how the form asks for it, and its rules. */
interface EditField {
  readonly label: string;
  readonly kind: 'TextInput' | 'TextArea' | 'NumberInput' | 'Toggle';
  readonly value: Value;
  readonly rules: string;
  readonly apply: (args: WorkspaceToolArgs, value: Value) => WorkspaceToolArgs;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const TITLE_RULES = '{required: true, maxLength: 240}';

/** The values of a request the owner may correct, by operation. Spec-based writes (blueprints,
 * views, fields, templates) are read-only on the card in this pass. */
function editFields(args: WorkspaceToolArgs): readonly EditField[] {
  const title: EditField = {
    label: 'Title',
    kind: 'TextInput',
    value: args.title,
    rules: TITLE_RULES,
    apply: (current, value) => ({ ...current, title: String(value) }),
  };
  const body = (required: boolean): EditField => ({
    label: 'Text',
    kind: 'TextArea',
    value: args.markdown,
    rules: required ? '{required: true, maxLength: 16000}' : '{maxLength: 16000}',
    apply: (current, value) => ({ ...current, markdown: String(value) }),
  });
  switch (args.operation) {
    case 'create_note':
      return [title, body(false)];
    case 'rename_item':
      return [title];
    case 'append_note':
      return [body(true)];
    case 'complete_task': {
      const spec = json(args.specJson) as { completed?: unknown } | undefined;
      return [
        {
          label: 'Mark as done',
          kind: 'Toggle',
          value: spec?.completed === true,
          rules: '{}',
          apply: (current, value) => ({
            ...current,
            specJson: JSON.stringify({ ...(spec ?? {}), completed: value === true }),
          }),
        },
      ];
    }
    case 'set_properties': {
      const values = json(args.propertiesJson);
      if (typeof values !== 'object' || values === null || Array.isArray(values)) return [];
      return Object.entries(values as Record<string, unknown>).flatMap(
        ([key, value]): EditField[] => {
          const kind =
            typeof value === 'number'
              ? 'NumberInput'
              : typeof value === 'boolean'
                ? 'Toggle'
                : typeof value === 'string'
                  ? 'TextInput'
                  : undefined;
          if (kind === undefined) return [];
          return [
            {
              label: key,
              kind,
              value: value as Value,
              rules: '{}',
              apply: (current, next) => {
                const merged = {
                  ...(json(current.propertiesJson) as Record<string, unknown>),
                  [key]: next,
                };
                return { ...current, propertiesJson: JSON.stringify(merged) };
              },
            },
          ];
        },
      );
    }
    default:
      return [];
  }
}

export function isEditable(args: WorkspaceToolArgs): boolean {
  return editFields(args).length > 0;
}

/** The form as a program Nix writes itself: labels are quoted as JSON strings, and every value
 * arrives through the renderer's state rather than the program text, so nothing a model wrote
 * is ever parsed as OpenUI Lang here. */
function formProgram(fields: readonly EditField[]): string {
  const names = fields.map((_, index) => `f${String(index)}`);
  const inputs = fields.map((field, index) => {
    const name = names[index] ?? '';
    const label = JSON.stringify(field.label);
    switch (field.kind) {
      case 'TextInput':
        return `${name} = TextInput(${label}, $${name}, "", ${field.rules})`;
      case 'TextArea':
        return `${name} = TextArea(${label}, $${name}, 6, ${field.rules})`;
      case 'NumberInput':
        return `${name} = NumberInput(${label}, $${name})`;
      case 'Toggle':
        return `${name} = Toggle(${label}, $${name})`;
    }
  });
  return [
    'root = Stack([form])',
    `form = Form("Edit this change", save, [${names.join(', ')}])`,
    ...inputs,
    'save = Button("Use these values", @ToAssistant("save"), "primary")',
  ].join('\n');
}

/** How the pet is told a changed value: the text itself, bounded, so its picture of what ran is
 * true (security review L3); a longer text says where to read the rest. */
const NOTE_TEXT_LIMIT = 600;

function describeValue(value: Value): string {
  if (typeof value !== 'string') return String(value);
  if (value.length <= NOTE_TEXT_LIMIT) return JSON.stringify(value);
  return `${JSON.stringify(value.slice(0, NOTE_TEXT_LIMIT))}… (cut; read the item for the rest)`;
}

/**
 * The owner's edit of a pending write, drawn with the same Form and rules generated components
 * use. Saving rebuilds the request from the original and the changed values, parses it with the
 * tool schema the executor uses, and hands it back for a fresh preview: an edit is approved only
 * after the card shows what the edited request would do.
 */
export function EditRequest({
  original,
  current,
  onSave,
  onCancel,
}: {
  /** The request as the model made it: edits are always rebuilt from it. */
  readonly original: WorkspaceToolArgs;
  /** The request as it stands, with any earlier edit: the form opens on these values. */
  readonly current: WorkspaceToolArgs;
  /** The edited request, or null when every value is back to the model's own. */
  readonly onSave: (edited: EditedRequest | null) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [fields] = useState(() => editFields(current));
  const [originals] = useState(() => editFields(original));
  const [program] = useState(() => formProgram(fields));
  const [initial] = useState(() =>
    Object.fromEntries(fields.map((field, index) => [`$f${String(index)}`, field.value])),
  );
  const state = useRef<Record<string, unknown>>(initial);
  const [error, setError] = useState('');

  function save(event: ActionEvent) {
    if (event.type !== BuiltinActionType.ContinueConversation) return;
    let next = original;
    const changes: string[] = [];
    fields.forEach((field, index) => {
      const raw = state.current[`$f${String(index)}`];
      const value: Value =
        field.kind === 'Toggle'
          ? raw === true
          : field.kind === 'NumberInput'
            ? Number(raw)
            : typeof raw === 'string'
              ? raw
              : '';
      next = field.apply(next, value);
      if (value !== originals[index]?.value) changes.push(`${field.label} ${describeValue(value)}`);
    });
    const parsed = workspaceToolSchema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    onSave(
      changes.length === 0
        ? null
        : {
            arguments: JSON.stringify(parsed.data),
            note: `The owner edited this request before approving; it ran with: ${changes.join('; ')}.`,
          },
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-divider p-3">
      <Renderer
        response={program}
        library={nixLibrary}
        initialState={initial}
        onStateUpdate={(next) => {
          state.current = next;
        }}
        onAction={save}
        publishObservability={false}
      />
      {error ? (
        <Text variant="note" role="alert">
          {error}
        </Text>
      ) : null}
      <div>
        <Button variant="ghost" onClick={onCancel}>
          Cancel editing
        </Button>
      </div>
    </div>
  );
}
