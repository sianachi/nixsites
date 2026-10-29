import { Blueprint, Tag, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { TemplateDetail, TemplatePreflight } from './template-api';
import type { RootTemplateFacts, StudioMode, TemplateDraft } from './template-studio-model';

export function Review({
  mode,
  draft,
  template,
  preflight,
  destination,
  rootFacts,
  missingFactsLabel,
}: {
  readonly mode: StudioMode;
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly preflight: TemplatePreflight | null;
  readonly destination: string;
  readonly rootFacts: RootTemplateFacts | null;
  readonly missingFactsLabel: string | null;
}): ReactNode {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Text variant="h3" as="h2">
          Review
        </Text>
        <Text variant="bodySmall" tone="muted">
          Nothing changes until you finish.
        </Text>
      </div>
      <TemplateBlueprint
        draft={draft}
        template={template}
        destination={destination}
        mode={mode}
        rootFacts={rootFacts}
        missingFactsLabel={missingFactsLabel}
      />
      {preflight === null ? null : (
        <Blueprint className="flex flex-col gap-2 p-4">
          <TemplateFact label="Fields added" value={String(preflight.additions.fields)} />
          <TemplateFact label="Views added" value={String(preflight.additions.views)} />
          <TemplateFact label="Items added" value={String(preflight.additions.items)} />
          {preflight.conflicts.map((conflict) => (
            <Text key={conflict} variant="bodySmall" role="alert">
              {conflict}
            </Text>
          ))}
          {preflight.initializationPreview.length ? (
            <div
              className="mt-3 flex flex-col gap-3 border-t border-divider pt-3"
              aria-label="Resolved template preview"
            >
              <Text variant="h3" as="h3">
                Resolved items
              </Text>
              {preflight.initializationPreview.map((item) => {
                const source = findTemplateItem(template?.root ?? null, item.sourceId);
                const rules = draft.initialization.rules.filter(
                  (rule) => rule.sourceId === item.sourceId,
                );
                const rows = Object.entries(item.properties ?? {}).map(([key, value]) => {
                  const rule = rules.find((candidate) => candidate.propertyKey === key);
                  const label =
                    source?.schema?.properties.find((property) => property.key === key)?.label ??
                    key;
                  const display =
                    rule?.kind === 'input'
                      ? (preflight.textBindings[rule.inputKey] ?? value)
                      : value;
                  return { key, label, value: readableValue(display) };
                });
                return (
                  <div key={item.sourceId} className="flex flex-col gap-1">
                    <Text variant="bodySmall">{item.title}</Text>
                    {rows.map((row) => (
                      <TemplateFact key={row.key} label={row.label} value={row.value} />
                    ))}
                    {item.recurrence === null ? null : (
                      <TemplateFact label="Repeats" value={readableRecurrence(item.recurrence)} />
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          {draft.initialization.references.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-divider pt-3">
              <Text variant="bodySmall">External link handling</Text>
              <TemplateFact
                label="Kept"
                value={String(
                  draft.initialization.references.filter((entry) => entry.policy === 'retain')
                    .length,
                )}
              />
              <TemplateFact
                label="Cleared"
                value={String(
                  draft.initialization.references.filter((entry) => entry.policy === 'omit').length,
                )}
              />
              <TemplateFact
                label="Replaced"
                value={String(
                  draft.initialization.references.filter((entry) => entry.policy === 'replace')
                    .length,
                )}
              />
              {draft.initialization.references.some((entry) => entry.policy === 'retain') ? (
                <Text variant="caption" tone="muted">
                  Kept links must be readable in the destination workspace.
                </Text>
              ) : null}
            </div>
          ) : null}
          {preflight.initializationPreview.some((item) => {
            const source = findTemplateItem(template?.root ?? null, item.sourceId);
            return (
              source?.schema?.properties.some((property) =>
                ['completion', 'dueDate', 'startDate', 'assignee'].includes(property.type),
              ) ?? false
            );
          }) ? (
            <Text variant="caption" tone="muted">
              Completion resets to No; due dates, start dates, and assignees clear unless setup
              rules preserve or replace them.
            </Text>
          ) : null}
        </Blueprint>
      )}
      {mode === 'edit' ? (
        <Text variant="caption" tone="muted">
          The template changes only when you save.
        </Text>
      ) : null}
    </section>
  );
}

function findTemplateItem(
  item: TemplateDetail['root'] | null,
  sourceId: string,
): TemplateDetail['root'] | null {
  if (item === null) return null;
  if (item.sourceId === sourceId) return item;
  for (const child of item.children) {
    const found = findTemplateItem(child, sourceId);
    if (found !== null) return found;
  }
  return null;
}

function readableValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(readableValue).join(', ');
  return value === null || value === undefined ? 'Empty' : 'Set';
}

function readableRecurrence(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'Configured';
  const rule = value as Record<string, unknown>;
  const frequency = typeof rule.frequency === 'string' ? rule.frequency : null;
  const until = typeof rule.until === 'string' ? rule.until : null;
  return (
    [frequency, until === null ? null : `through ${until}`].filter(Boolean).join(' · ') ||
    'Configured'
  );
}

export function TemplateBlueprint({
  draft,
  template,
  destination,
  mode,
  rootFacts,
  missingFactsLabel,
}: {
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly destination: string;
  readonly mode: StudioMode;
  readonly rootFacts: RootTemplateFacts | null;
  readonly missingFactsLabel: string | null;
}): ReactNode {
  return (
    <Blueprint className="flex flex-col gap-4 p-4">
      <div>
        <Text variant="kicker">Template blueprint</Text>
        <Text variant="h3">{draft.title || 'Untitled template'}</Text>
        {draft.description ? (
          <Text variant="bodySmall" tone="muted">
            {draft.description}
          </Text>
        ) : null}
      </div>
      <TemplateFacts
        template={template}
        fallback={draft}
        mode={mode}
        rootFacts={rootFacts}
        missingFactsLabel={missingFactsLabel}
      />
      <div className="border-t border-divider pt-3">
        <TemplateFact label="Destination" value={destination} />
      </div>
    </Blueprint>
  );
}

export function TemplateFacts({
  template,
  fallback,
  mode,
  rootFacts = null,
  missingFactsLabel = null,
}: {
  readonly template: TemplateDetail | null;
  readonly fallback?: TemplateDraft;
  readonly mode?: StudioMode;
  readonly rootFacts?: RootTemplateFacts | null;
  readonly missingFactsLabel?: string | null;
}): ReactNode {
  const fieldCount = rootFacts?.fieldCount ?? template?.fieldCount;
  const viewCount = rootFacts?.viewCount ?? template?.viewCount;
  const viewKinds = rootFacts?.viewKinds ?? template?.viewKinds ?? [];
  return (
    <div className="flex flex-col gap-2">
      <TemplateFact label="Fields" value={fieldCount?.toString() ?? missingFactsLabel ?? '0'} />
      <TemplateFact label="Views" value={viewCount?.toString() ?? missingFactsLabel ?? '0'} />
      <TemplateFact
        label="Children"
        value={
          template?.includeChildren === true || fallback?.includeChildren === true
            ? String(template?.childCount ?? 'Included')
            : 'Not included'
        }
      />
      <TemplateFact
        label="Content"
        value={
          template?.includeBody === true || fallback?.includeBody === true
            ? mode === 'apply'
              ? 'New items only'
              : 'Included'
            : 'Not included'
        }
      />
      {viewKinds.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {viewKinds.map((kind) => (
            <Tag key={kind}>{kind.replace('_', ' ')}</Tag>
          ))}
        </div>
      )}
    </div>
  );
}

export function TemplateFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="bodySmall" className="min-w-0 flex-1 text-right">
        {value}
      </Text>
    </div>
  );
}
