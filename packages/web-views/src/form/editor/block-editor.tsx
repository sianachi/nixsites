import { Button, Checkbox, Field, Select, Input, Text, Textarea } from '@nix/ui';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Icon } from '@nix/ui';
import type { ReactNode } from 'react';

import type { FormBlock, PropertyDefinition } from '@nix/web-collections/core/container-model';
import { BlockConditions } from './conditions';
import { FieldPicker } from './field-picker';

export function BlockEditor({
  block,
  schema,
  earlier,
  onChange,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  readonly block: FormBlock;
  readonly schema: readonly PropertyDefinition[];
  readonly earlier: readonly FormBlock[];
  readonly onChange: (block: FormBlock) => void;
  readonly onRemove: () => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}): ReactNode {
  const identityEligible =
    schema.find((property) => property.key === block.propertyKey)?.type === 'text';
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md bg-surface p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label={
            block.kind === 'field' ? 'Question' : block.kind === 'heading' ? 'Heading' : 'Text'
          }
          className="min-w-full @md:min-w-0 @md:flex-1"
        >
          {(control) =>
            block.kind === 'paragraph' ? (
              <Textarea
                {...control}
                rows={3}
                value={block.text}
                onChange={(event) => {
                  onChange({ ...block, text: event.target.value });
                }}
              />
            ) : (
              <Input
                {...control}
                value={block.text}
                onChange={(event) => {
                  onChange({ ...block, text: event.target.value });
                }}
              />
            )
          }
        </Field>
        <Button
          variant="icon"
          disabled={!canMoveUp}
          aria-label={`Move ${block.text} up`}
          onClick={() => {
            onMove(-1);
          }}
        >
          <Icon icon={ChevronUp} size="sm" />
        </Button>
        <Button
          variant="icon"
          disabled={!canMoveDown}
          aria-label={`Move ${block.text} down`}
          onClick={() => {
            onMove(1);
          }}
        >
          <Icon icon={ChevronDown} size="sm" />
        </Button>
        <Button variant="icon" aria-label={`Remove ${block.text}`} onClick={onRemove}>
          <Icon icon={Trash2} size="sm" />
        </Button>
      </div>
      {block.kind !== 'field' ? null : (
        <>
          <Checkbox
            label="Required"
            checked={block.required}
            onChange={(event) => {
              onChange({ ...block, required: event.target.checked });
            }}
          />
          <details className="flex min-w-0 flex-col gap-2">
            <summary className="min-h-11 cursor-pointer py-2">
              <Text variant="note" tone="muted" as="span">
                More options
                {block.visibleWhen.length > 0
                  ? ` (${String(block.visibleWhen.length)} ${block.visibleWhen.length === 1 ? 'condition' : 'conditions'})`
                  : ''}
              </Text>
            </summary>
            <div className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-2">
              <FieldPicker block={block} schema={schema} onChange={onChange} />
              <Field label="Respondent identity">
                {(control) => (
                  <Select
                    {...control}
                    disabled={!identityEligible}
                    value={block.identityRole ?? ''}
                    onChange={(event) => {
                      onChange({ ...block, identityRole: event.target.value || null });
                    }}
                  >
                    <option value="">Not identity</option>
                    <option value="name">Name</option>
                    <option value="email">Email</option>
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Help text">
              {(control) => (
                <Textarea
                  rows={3}
                  {...control}
                  value={block.help ?? ''}
                  onChange={(event) => {
                    onChange({ ...block, help: event.target.value || null });
                  }}
                />
              )}
            </Field>
            <BlockConditions block={block} earlier={earlier} onChange={onChange} />
          </details>
        </>
      )}
    </div>
  );
}
