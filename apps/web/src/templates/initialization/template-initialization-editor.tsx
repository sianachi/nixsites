import { Blueprint, Button, Checkbox, Field, Input, Select, Text } from '@nix/ui';
import { items as coreItems } from '@nix/api-client';
import { useEffect, useState, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspaceAssignablePrincipals } from '@nix/web-workspaces/workspaces/use-workspace-assignable-principals';
import type { TreeItem } from '../../items/use-workspace-tree';
import type {
  TemplateInitialization,
  TemplateInitializationRule,
  TemplateInput,
  TemplateItem,
  TemplateReferenceRule,
} from '../template-api';
import {
  availableDateInputs,
  collectTargets,
  compatibleInput,
  createRule,
  firstItemInput,
  requiredSetValue,
  targetFromRule,
  targetKey,
  withOptionalDefault,
} from './initialization-targets';
import { InputDefaultEditor, InputRuleEditor, RelativeDateRuleEditor } from './input-editors';
import { RuleValueEditor } from './rule-value-editor';

export function TemplateInitializationEditor({
  root,
  initialization,
  itemOptions,
  onChange,
}: {
  readonly root: TemplateItem;
  readonly initialization: TemplateInitialization;
  readonly itemOptions: readonly TreeItem[];
  readonly onChange: (initialization: TemplateInitialization) => void;
}): ReactNode {
  const members = useWorkspaceAssignablePrincipals();
  const client = useApiClient();
  const [referenceLabels, setReferenceLabels] = useState<Readonly<Record<string, string>>>({});
  const [timeRules, setTimeRules] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        initialization.rules.flatMap((rule) =>
          rule.kind === 'relativeDate' && rule.timeOfDay !== null ? [targetKey(rule)] : [],
        ),
      ),
  );
  const targets = collectTargets(root);

  useEffect(() => {
    const ids = [...new Set(initialization.references.map((reference) => reference.sourceItemId))];
    const active = new AbortController();
    const labels: Record<string, string> = {};
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!active.signal.aborted) {
        const index = cursor++;
        const id = ids[index];
        if (id === undefined) return;
        try {
          const item = await client.query(coreItems.itemById(id), {
            signal: active.signal,
            forceRefresh: true,
          });
          labels[id] = item.title || 'Untitled item';
        } catch {
          labels[id] = 'Unavailable item';
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(8, ids.length) }, () => worker())).then(() => {
      if (!active.signal.aborted) setReferenceLabels(labels);
    });
    return () => {
      active.abort();
    };
  }, [client, initialization.references]);

  function updateInput(index: number, next: TemplateInput): void {
    const previous = initialization.inputs[index];
    const previousKey = previous?.key;
    const keyChanged = previousKey !== undefined && previousKey !== next.key;
    const typeChanged = previous !== undefined && previous.type !== next.type;
    onChange({
      ...initialization,
      inputs: initialization.inputs.map((input, at) => (at === index ? next : input)),
      rules: initialization.rules
        .filter((rule) => {
          if (!typeChanged || !('inputKey' in rule) || rule.inputKey !== previousKey) return true;
          if (rule.kind === 'relativeDate') return next.type === 'date';
          const target = targets.find((entry) => targetKey(entry) === targetKey(rule));
          return target !== undefined && compatibleInput(next.type, target.type);
        })
        .map((rule) =>
          keyChanged && 'inputKey' in rule && rule.inputKey === previousKey
            ? { ...rule, inputKey: next.key }
            : rule,
        ),
      references: initialization.references.map((reference) =>
        reference.policy === 'replace' && reference.inputKey === previousKey
          ? next.type === 'item'
            ? { ...reference, inputKey: next.key }
            : { sourceItemId: reference.sourceItemId, policy: 'omit' }
          : reference,
      ),
    });
  }

  function removeInput(index: number): void {
    const removed = initialization.inputs[index];
    if (removed === undefined) return;
    const inputs = initialization.inputs.filter((_input, at) => at !== index);
    const rules = initialization.rules.filter(
      (rule) => !('inputKey' in rule) || rule.inputKey !== removed.key,
    );
    const references = initialization.references.map((reference) =>
      reference.policy === 'replace' && reference.inputKey === removed.key
        ? { sourceItemId: reference.sourceItemId, policy: 'omit' as const }
        : reference,
    );
    onChange({ ...initialization, inputs, rules, references });
  }

  function addInput(): void {
    if (initialization.inputs.length >= 100) return;
    const used = new Set(initialization.inputs.map((input) => input.key));
    let number = initialization.inputs.length + 1;
    while (used.has(`answer_${String(number)}`)) number += 1;
    onChange({
      ...initialization,
      inputs: [
        ...initialization.inputs,
        {
          key: `answer_${String(number)}`,
          label: `Answer ${String(number)}`,
          type: 'text',
          required: false,
          defaultValue: null,
        },
      ],
    });
  }

  function updateRule(index: number, next: TemplateInitializationRule): void {
    onChange({
      ...initialization,
      rules: initialization.rules.map((rule, at) => (at === index ? next : rule)),
    });
  }

  function addRule(): void {
    if (initialization.rules.length + initialization.references.length >= 2_000) return;
    const available = targets.find(
      (target) => !initialization.rules.some((rule) => targetKey(rule) === targetKey(target)),
    );
    if (available === undefined) return;
    onChange({
      ...initialization,
      rules: [
        ...initialization.rules,
        { sourceId: available.sourceId, propertyKey: available.propertyKey, kind: 'keep' },
      ],
    });
  }

  function addReference(reference: TemplateReferenceRule): void {
    onChange({
      ...initialization,
      references: initialization.references.map((entry) =>
        entry.sourceItemId === reference.sourceItemId ? reference : entry,
      ),
    });
  }

  return (
    <section
      className="@container/setup flex min-w-0 flex-col gap-4"
      aria-labelledby="template-setup-heading"
    >
      <div>
        <Text variant="h3" as="h2" id="template-setup-heading">
          Setup and portability
        </Text>
        <Text variant="bodySmall" tone="muted">
          Ask for values when an item is created, and choose what each captured field becomes. Use{' '}
          <code>{'{{input_key}}'}</code> in a title or text.
        </Text>
      </div>

      <Blueprint className="flex min-w-0 flex-col gap-3 p-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-full @lg/setup:basis-0">
            <Text variant="h4" as="h3">
              Questions
            </Text>
            <Text variant="caption" tone="muted">
              Text, date, workspace member, or item.
            </Text>
          </div>
          <Button
            variant="secondary"
            disabled={initialization.inputs.length >= 100}
            onClick={addInput}
          >
            Add question
          </Button>
        </div>
        {initialization.inputs.length === 0 ? (
          <Text variant="caption" tone="muted">
            No setup questions yet.
          </Text>
        ) : null}
        {initialization.inputs.map((input, index) => (
          <div
            key={index}
            className="grid min-w-0 gap-3 border-t border-divider pt-3 @2xl/setup:grid-cols-2"
          >
            <Field
              label="Question label"
              required
              error={input.label.trim().length === 0 ? 'Add a label.' : null}
            >
              {(control) => (
                <Input
                  {...control}
                  value={input.label}
                  maxLength={120}
                  onChange={(event) => {
                    updateInput(index, { ...input, label: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label="Input key" hint="Used in placeholders, for example {{project_name}}.">
              {(control) => (
                <Input
                  {...control}
                  value={input.key}
                  maxLength={64}
                  onChange={(event) => {
                    updateInput(index, { ...input, key: event.target.value });
                  }}
                />
              )}
            </Field>
            <div className="col-span-full flex min-w-0 flex-wrap items-end gap-3">
              <Field label="Answer type" className="min-w-0 flex-1 basis-full @lg/setup:basis-0">
                {(control) => (
                  <Select
                    {...control}
                    value={input.type}
                    onChange={(event) => {
                      const type = event.target.value as TemplateInput['type'];
                      const next = { ...input, type, defaultValue: null };
                      updateInput(index, next);
                    }}
                  >
                    <option value="text">Text</option>
                    <option value="date">Date</option>
                    <option value="member">Workspace member</option>
                    <option value="item">Item</option>
                  </Select>
                )}
              </Field>
              <Button
                variant="secondary"
                aria-label={`Remove question ${input.label}`}
                onClick={() => {
                  removeInput(index);
                }}
              >
                Remove
              </Button>
            </div>
            <Checkbox
              label="Required"
              className="col-span-full"
              checked={input.required}
              onChange={(event) => {
                updateInput(index, { ...input, required: event.target.checked });
              }}
            />
            <div className="col-span-full min-w-0">
              {input.type === 'member' ? (
                <Input
                  aria-label="Search workspace members"
                  value={members.query}
                  placeholder="Search workspace members"
                  onChange={(event) => {
                    members.setQuery(event.target.value);
                  }}
                />
              ) : null}
              <InputDefaultEditor
                input={input}
                itemOptions={itemOptions}
                members={members.principals}
                onChange={(defaultValue) => {
                  updateInput(index, withOptionalDefault(input, defaultValue));
                }}
              />
              {input.type === 'member' && members.hasMore ? (
                <Button
                  variant="secondary"
                  disabled={members.loadingMore}
                  onClick={() => void members.loadMore()}
                >
                  {members.loadingMore ? 'Loading members' : 'Load more members'}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </Blueprint>

      <Blueprint className="flex min-w-0 flex-col gap-3 p-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-full @lg/setup:basis-0">
            <Text variant="h4" as="h3">
              Field rules
            </Text>
            <Text variant="caption" tone="muted">
              Unlisted fields keep their values; completion resets and dates and assignees clear.
            </Text>
          </div>
          <Button
            variant="secondary"
            disabled={
              targets.length === 0 ||
              initialization.rules.length + initialization.references.length >= 2_000
            }
            onClick={addRule}
          >
            Add field rule
          </Button>
        </div>
        {initialization.rules.map((rule, index) => {
          const currentTarget = targets.find((target) => targetKey(target) === targetKey(rule));
          return (
            <div
              key={targetKey(rule)}
              className="grid min-w-0 gap-3 border-t border-divider pt-3 @2xl/setup:grid-cols-2"
            >
              <Field label="Item and field">
                {(control) => (
                  <Select
                    {...control}
                    value={targetKey(rule)}
                    onChange={(event) => {
                      const target = targets.find(
                        (entry) => targetKey(entry) === event.target.value,
                      );
                      if (target !== undefined) {
                        updateRule(index, {
                          sourceId: target.sourceId,
                          propertyKey: target.propertyKey,
                          kind: 'keep',
                        });
                      }
                    }}
                  >
                    {targets.map((target) => (
                      <option key={targetKey(target)} value={targetKey(target)}>
                        {target.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="When this item is created">
                {(control) => (
                  <Select
                    {...control}
                    value={rule.kind}
                    onChange={(event) => {
                      const next = createRule(
                        currentTarget ?? targetFromRule(rule),
                        event.target.value,
                        initialization.inputs,
                      );
                      updateRule(index, next);
                      if (next.kind !== 'relativeDate') {
                        setTimeRules(
                          (current) =>
                            new Set([...current].filter((key) => key !== targetKey(next))),
                        );
                      }
                    }}
                  >
                    <option value="keep">Keep the captured value</option>
                    <option value="clear">Clear the value</option>
                    <option value="set">Set a fixed value</option>
                    <option value="input">Use an answer</option>
                    {availableDateInputs(initialization.inputs).length > 0 ? (
                      <option value="relativeDate">Set a date relative to an answer</option>
                    ) : null}
                  </Select>
                )}
              </Field>
              <div className="col-span-full min-w-0">
                {rule.kind === 'set' ? (
                  <RuleValueEditor
                    target={currentTarget}
                    value={rule.value}
                    itemOptions={itemOptions}
                    onChange={(value) => {
                      updateRule(index, { ...rule, value: requiredSetValue(value) });
                    }}
                  />
                ) : null}
                {rule.kind === 'input' ? (
                  <InputRuleEditor
                    rule={rule}
                    target={currentTarget}
                    inputs={initialization.inputs}
                    onChange={(inputKey) => {
                      updateRule(index, { ...rule, inputKey });
                    }}
                  />
                ) : null}
                {rule.kind === 'relativeDate' ? (
                  <RelativeDateRuleEditor
                    rule={rule}
                    inputs={initialization.inputs}
                    useTime={timeRules.has(targetKey(rule))}
                    onChange={(next) => {
                      updateRule(index, next);
                    }}
                    onUseTimeChange={(enabled) => {
                      setTimeRules((current) => {
                        const next = new Set(current);
                        if (enabled) next.add(targetKey(rule));
                        else next.delete(targetKey(rule));
                        return next;
                      });
                      updateRule(index, {
                        ...rule,
                        ...(enabled
                          ? { timeOfDay: '09:00', timeZone: 'Europe/London' }
                          : { timeOfDay: null, timeZone: null }),
                      });
                    }}
                  />
                ) : null}
                <Button
                  variant="secondary"
                  className="mt-3"
                  aria-label={`Remove rule for ${currentTarget?.label ?? rule.propertyKey}`}
                  onClick={() => {
                    onChange({
                      ...initialization,
                      rules: initialization.rules.filter((_entry, at) => at !== index),
                    });
                  }}
                >
                  Remove field rule
                </Button>
              </div>
            </div>
          );
        })}
      </Blueprint>

      <Blueprint className="flex min-w-0 flex-col gap-3 p-3">
        <div>
          <Text variant="h4" as="h3">
            External item links
          </Text>
          <Text variant="caption" tone="muted">
            Keep, clear or replace each link to an item outside this template.
          </Text>
        </div>
        {initialization.references.length === 0 ? (
          <Text variant="caption" tone="muted">
            No external links were captured.
          </Text>
        ) : null}
        {initialization.references.map((reference) => (
          <div
            key={reference.sourceItemId}
            className="grid min-w-0 gap-3 border-t border-divider pt-3 @2xl/setup:grid-cols-2"
          >
            <Text variant="bodySmall" className="min-w-0 self-center wrap-anywhere">
              {referenceLabels[reference.sourceItemId] ?? 'Loading linked item…'}
            </Text>
            <Field label="On creation">
              {(control) => (
                <Select
                  {...control}
                  value={reference.policy}
                  onChange={(event) => {
                    const policy = event.target.value as TemplateReferenceRule['policy'];
                    addReference(
                      policy === 'replace'
                        ? {
                            sourceItemId: reference.sourceItemId,
                            policy,
                            inputKey: firstItemInput(initialization.inputs),
                          }
                        : { sourceItemId: reference.sourceItemId, policy },
                    );
                  }}
                >
                  <option value="omit">Clear the external link</option>
                  <option value="retain">Keep the link if authorized</option>
                  <option
                    value="replace"
                    disabled={!initialization.inputs.some((input) => input.type === 'item')}
                  >
                    Choose a replacement item
                  </option>
                </Select>
              )}
            </Field>
            {reference.policy === 'replace' ? (
              <Field label="Replacement item" className="col-span-full">
                {(control) => (
                  <Select
                    {...control}
                    value={reference.inputKey}
                    onChange={(event) => {
                      addReference({ ...reference, inputKey: event.target.value });
                    }}
                  >
                    <option value="">Choose an item answer</option>
                    {initialization.inputs
                      .filter((input) => input.type === 'item')
                      .map((input) => (
                        <option key={input.key} value={input.key}>
                          {input.label}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            ) : null}
            <Text variant="caption" tone="muted" className="col-span-full">
              {reference.policy === 'retain'
                ? 'The applying workspace must authorize this linked item.'
                : reference.policy === 'replace'
                  ? 'The selected item answer replaces this link.'
                  : 'The external link is omitted from created bodies.'}
            </Text>
          </div>
        ))}
      </Blueprint>
      {members.status === 'error' &&
      initialization.inputs.some((input) => input.type === 'member') ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Text as="p" role="alert" variant="caption">
            Assignable principals could not be loaded.
          </Text>
          <Button variant="secondary" onClick={() => void members.reload()}>
            Retry member loading
          </Button>
        </div>
      ) : null}
    </section>
  );
}
