import { Button, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PropertyInput, isKnownPropertyType } from '../../../collections/properties/property-input';
import type {
  FormCondition,
  InteractiveFormDefinition,
  PropertyDefinition,
  PropertyValue,
} from '../../../collections/core/container-model';

export function InteractiveFormRespondentPreview({
  form,
  schema,
}: {
  readonly form: InteractiveFormDefinition;
  readonly schema: readonly PropertyDefinition[];
}): ReactNode {
  const [pageIndex, setPageIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, PropertyValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [complete, setComplete] = useState(false);
  const previewRef = useRef<HTMLElement>(null);

  useEffect(() => {
    previewRef.current?.focus();
  }, [pageIndex, complete]);

  const pages = form.pages.filter((page) => formPartVisible(page.visibleWhen, answers));
  const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];

  if (complete) {
    return (
      <aside
        ref={previewRef}
        tabIndex={-1}
        aria-label="Form preview"
        className="flex min-w-0 flex-col gap-3 border border-divider bg-background p-3"
      >
        <Text variant="h3" as="h3" className="wrap-anywhere">
          {form.confirmationTitle}
        </Text>
        <Text tone="muted" className="wrap-anywhere">
          {form.confirmationMessage}
        </Text>
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            setComplete(false);
            setPageIndex(0);
          }}
        >
          Preview again
        </Button>
      </aside>
    );
  }

  if (page === undefined) {
    return (
      <aside aria-label="Form preview" className="border border-divider bg-background p-4">
        <Text tone="muted" className="wrap-anywhere">
          No page is currently visible.
        </Text>
      </aside>
    );
  }

  const blocks = page.blocks.filter((block) => formPartVisible(block.visibleWhen, answers));
  const last = pageIndex >= pages.length - 1;
  function advance(): void {
    const missing = Object.fromEntries(
      blocks
        .filter(
          (block) => block.kind === 'field' && block.required && emptyAnswer(answers[block.id]),
        )
        .map((block) => [block.id, 'This answer is required.']),
    );
    setErrors(missing);
    if (Object.keys(missing).length > 0) {
      requestAnimationFrame(() =>
        previewRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    if (last) setComplete(true);
    else setPageIndex((current) => current + 1);
  }

  return (
    <aside
      ref={previewRef}
      tabIndex={-1}
      aria-label="Form preview"
      className="flex min-w-0 flex-col gap-4 border border-divider bg-background p-3"
    >
      <header className="flex flex-col gap-1 border-b border-divider pb-3">
        <Text variant="caption" tone="muted">
          Page {String(pageIndex + 1)} of {String(pages.length)}
        </Text>
        <Text variant="h3" as="h3" className="wrap-anywhere">
          {page.title}
        </Text>
        {page.description === null ? null : (
          <Text tone="muted" className="wrap-anywhere">
            {page.description}
          </Text>
        )}
      </header>
      {blocks.map((block) => {
        if (block.kind === 'heading')
          return (
            <Text key={block.id} variant="h4" as="h4" className="wrap-anywhere">
              {block.text}
            </Text>
          );
        if (block.kind === 'paragraph')
          return (
            <Text key={block.id} tone="muted" className="wrap-anywhere">
              {block.text}
            </Text>
          );
        const property = schema.find((candidate) => candidate.key === block.propertyKey);
        if (property === undefined || !isKnownPropertyType(property.type)) return null;
        return (
          <div key={block.id} className="flex flex-col gap-1">
            {block.help === null ? null : (
              <Text variant="note" tone="muted">
                {block.help}
              </Text>
            )}
            <PropertyInput
              item={{
                title: '',
                properties:
                  answers[block.id] === undefined ? {} : { [block.id]: answers[block.id] },
              }}
              property={{ ...property, key: block.id, label: block.text, required: block.required }}
              error={errors[block.id] ?? null}
              allowInputStorage={false}
              onCommit={(value) => {
                setAnswers((current) => ({ ...current, [block.id]: value }));
                setErrors((current) =>
                  Object.fromEntries(Object.entries(current).filter(([id]) => id !== block.id)),
                );
              }}
            />
          </div>
        );
      })}
      <div className="sticky bottom-0 -mx-3 flex min-w-0 flex-wrap gap-2 border-t border-divider bg-background px-3 py-2">
        {pageIndex === 0 ? null : (
          <Button
            variant="secondary"
            onClick={() => {
              setPageIndex((current) => current - 1);
            }}
          >
            Back
          </Button>
        )}
        <Button onClick={advance}>{last ? 'Preview confirmation' : 'Continue'}</Button>
      </div>
    </aside>
  );
}

function formPartVisible(
  conditions: readonly FormCondition[],
  answers: Readonly<Record<string, PropertyValue>>,
): boolean {
  return conditions.every((condition) => {
    const answer = answers[condition.fieldBlockId];
    const expected = condition.value ?? '';
    if (condition.operator === 'checked') return answer === true;
    if (condition.operator === 'not_checked') return answer !== true;
    if (condition.operator === 'not_equals') return String(answer ?? '') !== expected;
    if (condition.operator === 'contains')
      return Array.isArray(answer)
        ? answer.includes(expected)
        : String(answer ?? '').includes(expected);
    return String(answer ?? '') === expected;
  });
}

function emptyAnswer(value: PropertyValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}
