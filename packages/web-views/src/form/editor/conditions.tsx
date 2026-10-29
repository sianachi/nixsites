import { Button, Field, Input, Select, Text } from '@nix/ui';
import { Plus, Trash2 } from 'lucide-react';
import { Icon } from '@nix/ui';
import type { ReactNode } from 'react';

import type { FormBlock, FormCondition } from '@nix/web-collections/core/container-model';
import { insertAt, useUndoRemove } from '../../core/use-undo-remove';

export function PageConditions({
  conditions,
  earlier,
  onChange,
}: {
  readonly conditions: readonly FormCondition[];
  readonly earlier: readonly FormBlock[];
  readonly onChange: (conditions: FormCondition[]) => void;
}): ReactNode {
  const { track, notice } = useUndoRemove(conditions, (next) => {
    onChange([...next]);
  });
  if (earlier.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-divider p-3">
      <Text variant="note" tone="muted">
        Show this page only when all match
      </Text>
      {conditions.map((condition, index) => (
        <div
          key={`${condition.fieldBlockId}-${String(index)}`}
          role="group"
          aria-label={`Condition ${String(index + 1)}`}
          className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
        >
          <Select
            aria-label="Page condition field"
            value={condition.fieldBlockId}
            onChange={(event) => {
              onChange(
                conditions.map((entry, position) =>
                  position === index ? { ...entry, fieldBlockId: event.target.value } : entry,
                ),
              );
            }}
          >
            {earlier.map((field) => (
              <option key={field.id} value={field.id}>
                {field.text}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Page condition rule"
            value={condition.operator}
            onChange={(event) => {
              onChange(
                conditions.map((entry, position) =>
                  position === index ? { ...entry, operator: event.target.value } : entry,
                ),
              );
            }}
          >
            <option value="equals">Equals</option>
            <option value="not_equals">Does not equal</option>
            <option value="contains">Contains</option>
            <option value="checked">Is checked</option>
            <option value="not_checked">Is not checked</option>
          </Select>
          <Input
            aria-label="Page condition value"
            disabled={condition.operator === 'checked' || condition.operator === 'not_checked'}
            value={condition.value ?? ''}
            onChange={(event) => {
              onChange(
                conditions.map((entry, position) =>
                  position === index ? { ...entry, value: event.target.value } : entry,
                ),
              );
            }}
          />
          <Button
            variant="icon"
            aria-label="Remove page condition"
            onClick={() => {
              track('page condition', (state) => insertAt(state, index, condition));
              onChange(conditions.filter((_, position) => position !== index));
            }}
          >
            <Icon icon={Trash2} size="sm" />
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          onChange([
            ...conditions,
            { fieldBlockId: earlier[0]?.id ?? '', operator: 'equals', value: '' },
          ]);
        }}
      >
        <Icon icon={Plus} size="sm" /> Add page condition
      </Button>
      {notice}
    </div>
  );
}

export function BlockConditions({
  block,
  earlier,
  onChange,
}: {
  readonly block: FormBlock;
  readonly earlier: readonly FormBlock[];
  readonly onChange: (block: FormBlock) => void;
}): ReactNode {
  const { track, notice } = useUndoRemove(block, onChange);
  if (earlier.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-divider p-3">
      <Text variant="note" tone="muted">
        Show only when all match
      </Text>
      {block.visibleWhen.map((condition, conditionIndex) => (
        <div
          key={`${condition.fieldBlockId}-${String(conditionIndex)}`}
          role="group"
          aria-label={`Condition ${String(conditionIndex + 1)}`}
          className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
        >
          <Field label="Field">
            {(control) => (
              <Select
                {...control}
                value={condition.fieldBlockId}
                onChange={(event) => {
                  onChange({
                    ...block,
                    visibleWhen: block.visibleWhen.map((entry, index) =>
                      index === conditionIndex
                        ? { ...entry, fieldBlockId: event.target.value }
                        : entry,
                    ),
                  });
                }}
              >
                {earlier.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.text}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Rule">
            {(control) => (
              <Select
                {...control}
                value={condition.operator}
                onChange={(event) => {
                  onChange({
                    ...block,
                    visibleWhen: block.visibleWhen.map((entry, index) =>
                      index === conditionIndex ? { ...entry, operator: event.target.value } : entry,
                    ),
                  });
                }}
              >
                <option value="equals">Equals</option>
                <option value="not_equals">Does not equal</option>
                <option value="contains">Contains</option>
                <option value="checked">Is checked</option>
                <option value="not_checked">Is not checked</option>
              </Select>
            )}
          </Field>
          <Field label="Value">
            {(control) => (
              <Input
                {...control}
                disabled={condition.operator === 'checked' || condition.operator === 'not_checked'}
                value={condition.value ?? ''}
                onChange={(event) => {
                  onChange({
                    ...block,
                    visibleWhen: block.visibleWhen.map((entry, index) =>
                      index === conditionIndex ? { ...entry, value: event.target.value } : entry,
                    ),
                  });
                }}
              />
            )}
          </Field>
          <Button
            variant="icon"
            aria-label="Remove condition"
            onClick={() => {
              track('condition', (state) => ({
                ...state,
                visibleWhen: insertAt(state.visibleWhen, conditionIndex, condition),
              }));
              onChange({
                ...block,
                visibleWhen: block.visibleWhen.filter((_, index) => index !== conditionIndex),
              });
            }}
          >
            <Icon icon={Trash2} size="sm" />
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          onChange({
            ...block,
            visibleWhen: [
              ...block.visibleWhen,
              { fieldBlockId: earlier[0]?.id ?? '', operator: 'equals', value: '' },
            ],
          });
        }}
      >
        <Icon icon={Plus} size="sm" /> Add condition
      </Button>
      {notice}
    </div>
  );
}
