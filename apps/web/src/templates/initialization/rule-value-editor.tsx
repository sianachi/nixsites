import { Button, Checkbox, Field, Input, Select, Textarea } from '@nix/ui';
import type { ReactNode } from 'react';

import type { TreeItem } from '../../items/use-workspace-tree';
import { useWorkspaceAssignablePrincipals } from '@nix/web-workspaces/workspaces/use-workspace-assignable-principals';
import { TemplateItemPicker } from '../template-item-picker';
import type { TargetOption } from './initialization-targets';

export function RuleValueEditor({
  target,
  value,
  itemOptions,
  onChange,
}: {
  readonly target: TargetOption | undefined;
  readonly value: unknown;
  readonly itemOptions: readonly TreeItem[];
  readonly onChange: (value: unknown) => void;
}): ReactNode {
  const memberDirectory = useWorkspaceAssignablePrincipals();
  if (target?.type === 'multiselect' && target.options.length > 0) {
    const selected = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Fixed values</legend>
        {target.options.map((option) => (
          <Checkbox
            key={option}
            label={option}
            checked={selected.includes(option)}
            onChange={(event) => {
              onChange(
                event.target.checked
                  ? [...selected, option]
                  : selected.filter((entry) => entry !== option),
              );
            }}
          />
        ))}
      </fieldset>
    );
  }
  if (target?.options.length) {
    return (
      <Field label="Fixed value">
        {(control) => (
          <Select
            {...control}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          >
            <option value="">Choose a value</option>
            {target.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  if (
    target?.propertyKey === 'recurrence.until' ||
    target?.type.toLocaleLowerCase().includes('date')
  ) {
    return (
      <Field label="Fixed date">
        {(control) => (
          <Input
            {...control}
            type="date"
            value={typeof value === 'string' ? value.slice(0, 10) : ''}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        )}
      </Field>
    );
  }
  if (target?.type === 'item') {
    return (
      <TemplateItemPicker
        label="Fixed item"
        value={typeof value === 'string' ? value : ''}
        loadedItems={itemOptions}
        onChange={(next) => {
          onChange(next ?? '');
        }}
      />
    );
  }
  if (target?.type === 'checkbox' || target?.type === 'completion') {
    return (
      <Field label="Fixed value">
        {(control) => (
          <Select
            {...control}
            value={typeof value === 'boolean' && value ? 'true' : 'false'}
            onChange={(event) => {
              onChange(event.target.value === 'true');
            }}
          >
            <option value="false">No</option>
            <option value="true">Yes</option>
          </Select>
        )}
      </Field>
    );
  }
  if (target?.type === 'assignee') {
    const principals = memberDirectory.principals;
    return (
      <Field
        label="Fixed assignee"
        error={
          memberDirectory.status === 'error' ? 'Assignable principals could not be loaded.' : null
        }
      >
        {(control) => (
          <div className="flex flex-col gap-2">
            <Input
              aria-label="Search workspace members"
              placeholder="Search workspace members"
              value={memberDirectory.query}
              onChange={(event) => {
                memberDirectory.setQuery(event.target.value);
              }}
            />
            <Select
              {...control}
              value={typeof value === 'string' ? value : ''}
              disabled={memberDirectory.status !== 'ready'}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            >
              <option value="">Choose a workspace member</option>
              {principals.map((member) => (
                <option key={member.principalId} value={member.principalId}>
                  {member.displayName}
                </option>
              ))}
            </Select>
            {memberDirectory.hasMore ? (
              <Button
                variant="secondary"
                disabled={memberDirectory.loadingMore}
                onClick={() => void memberDirectory.loadMore()}
              >
                {memberDirectory.loadingMore ? 'Loading members' : 'Load more members'}
              </Button>
            ) : null}
          </div>
        )}
      </Field>
    );
  }
  if (target?.type === 'number' || target?.type === 'estimate') {
    return (
      <Field label="Fixed number">
        {(control) => (
          <Input
            {...control}
            type="number"
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(event) => {
              onChange(Number(event.target.value));
            }}
          />
        )}
      </Field>
    );
  }
  if (target?.type === 'priority') {
    return (
      <Field label="Fixed priority">
        {(control) => (
          <Select
            {...control}
            value={typeof value === 'number' ? String(value) : ''}
            onChange={(event) => {
              onChange(Number(event.target.value));
            }}
          >
            <option value="">Choose priority</option>
            <option value="1">1 · Highest</option>
            <option value="2">2 · High</option>
            <option value="3">3 · Normal</option>
            <option value="4">4 · Low</option>
          </Select>
        )}
      </Field>
    );
  }
  if (target?.type === 'long_text') {
    return (
      <Field label="Fixed text">
        {(control) => (
          <Textarea
            {...control}
            autoGrow
            className="max-h-64"
            value={typeof value === 'string' ? value : ''}
            maxLength={8_000}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        )}
      </Field>
    );
  }
  return (
    <Field label="Fixed text">
      {(control) => (
        <Input
          {...control}
          value={typeof value === 'string' ? value : ''}
          maxLength={4_096}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}
