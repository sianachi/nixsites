import { Checkbox, Field, Input, Select } from '@nix/ui';
import type { ReactNode } from 'react';

import type { TreeItem } from '@nix/web-collections/items/use-workspace-tree';
import { TemplateItemPicker } from '@nix/web-collections/items/template-item-picker';
import type { TemplateInitializationRule, TemplateInput } from '../template-api';
import { availableDateInputs, compatibleInput, type TargetOption } from './initialization-targets';

export function InputDefaultEditor({
  input,
  itemOptions,
  members,
  onChange,
}: {
  readonly input: TemplateInput;
  readonly itemOptions: readonly TreeItem[];
  readonly members: readonly { readonly principalId: string; readonly displayName: string }[];
  readonly onChange: (value: string | undefined) => void;
}): ReactNode {
  if (input.type === 'member') {
    return (
      <Field label="Default member" hint="Optional. Choose from workspace members.">
        {(control) => (
          <Select
            {...control}
            value={input.defaultValue ?? ''}
            onChange={(event) => {
              onChange(event.target.value || undefined);
            }}
            disabled={members.length === 0}
          >
            <option value="">No default</option>
            {members.map((member) => (
              <option key={member.principalId} value={member.principalId}>
                {member.displayName}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  if (input.type === 'item') {
    return (
      <TemplateItemPicker
        label="Default item"
        hint="Optional. Search for an accessible item."
        value={input.defaultValue ?? ''}
        loadedItems={itemOptions}
        onChange={(value) => {
          onChange(value ?? undefined);
        }}
      />
    );
  }
  return (
    <Field label="Default answer" hint="Optional. A person can change it before preview.">
      {(control) => (
        <Input
          {...control}
          type={input.type === 'date' ? 'date' : 'text'}
          value={input.defaultValue ?? ''}
          maxLength={4_096}
          onChange={(event) => {
            onChange(event.target.value.length === 0 ? undefined : event.target.value);
          }}
        />
      )}
    </Field>
  );
}

export function InputRuleEditor({
  rule,
  target,
  inputs,
  onChange,
}: {
  readonly rule: Extract<TemplateInitializationRule, { kind: 'input' }>;
  readonly target: TargetOption | undefined;
  readonly inputs: readonly TemplateInput[];
  readonly onChange: (inputKey: string) => void;
}): ReactNode {
  const candidates = inputs.filter((input) => compatibleInput(input.type, target?.type));
  return (
    <Field
      label="Answer to use"
      error={candidates.length === 0 ? 'Add a compatible question first.' : null}
    >
      {(control) => (
        <Select
          {...control}
          value={rule.inputKey}
          disabled={candidates.length === 0}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="">Choose an answer</option>
          {candidates.map((input) => (
            <option key={input.key} value={input.key}>
              {input.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

export function RelativeDateRuleEditor({
  rule,
  inputs,
  useTime,
  onChange,
  onUseTimeChange,
}: {
  readonly rule: Extract<TemplateInitializationRule, { kind: 'relativeDate' }>;
  readonly inputs: readonly TemplateInput[];
  readonly useTime: boolean;
  readonly onChange: (rule: Extract<TemplateInitializationRule, { kind: 'relativeDate' }>) => void;
  readonly onUseTimeChange: (enabled: boolean) => void;
}): ReactNode {
  const dateInputs = availableDateInputs(inputs);
  return (
    <div className="@container/date-rule flex min-w-0 flex-col gap-3">
      <div className="grid min-w-0 gap-3 @lg/date-rule:grid-cols-2">
        <Field
          label="Date answer"
          error={dateInputs.length === 0 ? 'Add a date question first.' : null}
        >
          {(control) => (
            <Select
              {...control}
              value={rule.inputKey}
              disabled={dateInputs.length === 0}
              onChange={(event) => {
                onChange({ ...rule, inputKey: event.target.value });
              }}
            >
              <option value="">Choose a date answer</option>
              {dateInputs.map((input) => (
                <option key={input.key} value={input.key}>
                  {input.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Days from that date" hint="Use a negative number for days before.">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={-36_500}
              max={36_500}
              value={String(rule.offsetDays)}
              onChange={(event) => {
                onChange({ ...rule, offsetDays: Number(event.target.value) });
              }}
            />
          )}
        </Field>
      </div>
      <Checkbox
        label="Set a time and time zone"
        checked={useTime}
        onChange={(event) => {
          onUseTimeChange(event.target.checked);
        }}
      />
      {useTime ? (
        <div className="grid min-w-0 gap-3 @lg/date-rule:grid-cols-2">
          <Field label="Time">
            {(control) => (
              <Input
                {...control}
                type="time"
                value={rule.timeOfDay ?? '09:00'}
                onChange={(event) => {
                  onChange({
                    ...rule,
                    timeOfDay: event.target.value,
                    timeZone: rule.timeZone ?? 'Europe/London',
                  });
                }}
              />
            )}
          </Field>
          <Field label="Time zone" hint="Use an IANA time-zone name, such as Europe/London.">
            {(control) => (
              <Input
                {...control}
                value={rule.timeZone ?? 'Europe/London'}
                maxLength={128}
                onChange={(event) => {
                  onChange({
                    ...rule,
                    timeZone: event.target.value,
                    timeOfDay: rule.timeOfDay ?? '09:00',
                  });
                }}
              />
            )}
          </Field>
        </div>
      ) : null}
    </div>
  );
}
