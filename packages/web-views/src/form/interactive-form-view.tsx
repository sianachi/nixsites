import { Button, Checkbox, Text, useUndo } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PropertyInput, isKnownPropertyType } from '@nix/web-collections/properties/property-input';
import type {
  FormBlock,
  FormCondition,
  InteractiveFormDefinition,
  PropertyValue,
  PropertyDefinition,
} from '@nix/web-collections/core/container-model';
import { resolveLoadState } from '../core/view-chrome';
import type { ViewRendererProps } from '../core/view-kinds';
import { reportFormValidity } from './form-validity';
import { FormResults } from './form-results';

type FormPage = InteractiveFormDefinition['pages'][number];

function conditionMatches(
  condition: FormCondition,
  answers: Record<string, PropertyValue>,
): boolean {
  const answer = answers[condition.fieldBlockId];
  const expected = condition.value ?? '';
  if (condition.operator === 'checked') return answer === true;
  if (condition.operator === 'not_checked') return answer !== true;
  if (condition.operator === 'not_equals') return String(answer ?? '') !== expected;
  if (condition.operator === 'contains') {
    return Array.isArray(answer)
      ? answer.includes(expected)
      : String(answer ?? '').includes(expected);
  }
  return String(answer ?? '') === expected;
}

function isVisible(
  conditions: readonly FormCondition[],
  answers: Record<string, PropertyValue>,
): boolean {
  return conditions.every((condition) => conditionMatches(condition, answers));
}

function isEmpty(value: PropertyValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function resolveFlow(
  pages: readonly FormPage[],
  answers: Readonly<Record<string, PropertyValue>>,
): { pages: FormPage[]; answers: Record<string, PropertyValue> } {
  const effective: Record<string, PropertyValue> = {};
  const shown: FormPage[] = [];
  for (const page of pages) {
    if (!isVisible(page.visibleWhen, effective)) continue;
    const blocks = page.blocks.filter((block) => {
      if (!isVisible(block.visibleWhen, effective)) return false;
      if (block.kind === 'field' && answers[block.id] !== undefined) {
        effective[block.id] = answers[block.id] ?? null;
      }
      return true;
    });
    shown.push({ ...page, blocks });
  }
  return { pages: shown, answers: effective };
}

function draftKey(viewId: string): string {
  return `nix:interactive-form-draft:${viewId}`;
}

function readDraft(viewId: string): Record<string, PropertyValue> {
  try {
    const raw = sessionStorage.getItem(draftKey(viewId));
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, PropertyValue>)
      : {};
  } catch {
    return {};
  }
}

function writeDraft(viewId: string, answers: Record<string, PropertyValue>): void {
  try {
    if (Object.keys(answers).length === 0) sessionStorage.removeItem(draftKey(viewId));
    else sessionStorage.setItem(draftKey(viewId), JSON.stringify(answers));
  } catch {
    // Storage can be blocked; the draft is a convenience.
  }
}

export function InteractiveFormView({ container, view }: ViewRendererProps): ReactNode {
  const form = view.interactiveForm;
  const undo = useUndo();
  const [initial] = useState(() => readDraft(view.id));
  const [restored, setRestored] = useState(() => Object.keys(initial).length > 0);
  const [answers, setAnswers] = useState<Record<string, PropertyValue>>(initial);
  const answersRef = useRef(answers);
  // Remounts the inputs when answers are cleared or restored, so they show the new values.
  const [generation, setGeneration] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [completion, setCompletion] = useState<'saved' | 'temporary' | null>(null);
  const [saveChoice, setSaveChoice] = useState<boolean | null>(null);
  const saveResponse = saveChoice ?? view.mode !== 'temporary';
  // Temporary mode promises nothing is kept, so only saved responses keep a draft.
  useEffect(() => {
    writeDraft(view.id, saveResponse && completion === null ? answers : {});
  }, [view.id, saveResponse, completion, answers]);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [missing, setMissing] = useState<{ id: string; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pageHeaderRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (completion !== null) pageHeaderRef.current?.focus();
  }, [completion]);

  const definitions = new Map(
    (container.schema?.properties ?? []).map((property) => [property.key, property]),
  );

  const loadState = resolveLoadState(container, 'this interactive form');
  if (loadState !== null) return loadState;
  if (form === null || form === undefined || form.pages.length === 0) {
    return (
      <Text tone="muted" className="wrap-anywhere">
        Configure this interactive form in Views before collecting responses.
      </Text>
    );
  }
  const definition = form;

  const flow = resolveFlow(definition.pages, answers);
  const visiblePages = flow.pages;
  const properties: Record<string, PropertyValue> = {};
  for (const block of visiblePages.flatMap((entry) => entry.blocks)) {
    if (
      block.kind === 'field' &&
      block.propertyKey !== null &&
      flow.answers[block.id] !== undefined
    ) {
      properties[block.propertyKey] = flow.answers[block.id] ?? null;
    }
  }
  const requiredBlocks = visiblePages
    .flatMap((entry) => entry.blocks)
    .filter((block) => block.kind === 'field' && block.required);
  const answeredCount = requiredBlocks.filter((block) => !isEmpty(flow.answers[block.id])).length;

  if (completion !== null) {
    return (
      <section
        ref={pageHeaderRef}
        tabIndex={-1}
        aria-live="polite"
        className="flex min-w-0 w-full max-w-xl flex-col gap-2 rounded-md border border-divider p-3"
      >
        <Text variant="h3" as="h2" className="wrap-anywhere">
          {completion === 'saved' ? definition.confirmationTitle : 'Results ready'}
        </Text>
        <Text tone="muted" className="wrap-anywhere">
          {completion === 'saved'
            ? definition.confirmationMessage
            : 'No response was saved. These answers stay here until you leave or clear them.'}
        </Text>
        <FormResults properties={container.schema?.properties ?? []} values={properties} />
        {completion === 'temporary' ? (
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => {
              setCompletion(null);
            }}
          >
            Edit answers
          </Button>
        ) : null}
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            setAnswers({});
            answersRef.current = {};
            setGeneration((current) => current + 1);
            setCompletion(null);
          }}
        >
          {completion === 'saved' ? 'Add another response' : 'Clear inputs and start again'}
        </Button>
      </section>
    );
  }

  if (visiblePages.length === 0)
    return (
      <Text tone="muted" className="wrap-anywhere">
        No page currently matches these answers.
      </Text>
    );

  function setAll(next: Record<string, PropertyValue>): void {
    answersRef.current = next;
    setAnswers(next);
    setErrors({});
    setOutcome(null);
    setRestored(false);
    setGeneration((current) => current + 1);
  }

  function clearAnswers(): void {
    const previous = answersRef.current;
    if (Object.keys(previous).length === 0) return;
    setAll({});
    // Answers typed after the clear win over the ones brought back.
    undo.push('Cleared your answers', () => {
      setAll({ ...previous, ...answersRef.current });
    });
  }

  function focusField(id: string): void {
    requestAnimationFrame(() => {
      const target = formRef.current?.querySelector<HTMLElement>(`[data-block="${id}"]`);
      const input = target?.querySelector<HTMLElement>('input, select, textarea') ?? target;
      // jsdom has no scrollIntoView; guard it without an optional chain the types call redundant.
      if (input !== null && typeof input.scrollIntoView === 'function')
        input.scrollIntoView({ block: 'center' });
      input?.focus();
    });
  }

  function validate(blocks: readonly FormBlock[]): boolean {
    if (!reportFormValidity(formRef.current)) return false;
    const currentAnswers = answersRef.current;
    const required = Object.fromEntries(
      blocks
        .filter(
          (candidate) =>
            candidate.kind === 'field' &&
            candidate.required &&
            isEmpty(currentAnswers[candidate.id]),
        )
        .map((candidate) => [candidate.id, 'This answer is required.']),
    );
    setErrors(required);
    if (Object.keys(required).length === 0) return true;
    setOutcome(
      `${String(Object.keys(required).length)} required ${
        Object.keys(required).length === 1 ? 'answer is' : 'answers are'
      } still empty: ${blocks
        .filter((block) => block.id in required)
        .map((block) => block.text)
        .join(', ')}.`,
    );
    const firstMissing = blocks.find((block) => block.id in required);
    if (firstMissing !== undefined) {
      setMissing({ id: firstMissing.id, text: firstMissing.text });
      focusField(firstMissing.id);
    }
    return false;
  }

  async function finish(): Promise<void> {
    // `aria-disabled` on the submit button below is a hint, not a lock - it does not stop a second
    // Enter or a second tap from reaching this handler, and without this guard both would race to
    // `container.create` and leave two responses where the reader asked for one. `form-view.tsx`
    // guards the same way for the same reason.
    if (sending) return;

    const currentAnswers = answersRef.current;
    const flow = resolveFlow(definition.pages, currentAnswers);
    const shownBlocks = flow.pages.flatMap((entry) => entry.blocks);
    if (!validate(shownBlocks)) return;
    setMissing(null);

    if (!saveResponse) {
      setOutcome(null);
      setCompletion('temporary');
      return;
    }

    const properties: Record<string, PropertyValue> = {};
    for (const block of shownBlocks) {
      if (
        block.kind === 'field' &&
        block.propertyKey !== null &&
        flow.answers[block.id] !== undefined
      ) {
        properties[block.propertyKey] = flow.answers[block.id] ?? null;
      }
    }
    const titleBlock = visiblePages
      .flatMap((entry) => entry.blocks)
      .find((block) => block.id === definition.titleFieldBlockId);
    const title =
      definition.titleMode === 'field' && titleBlock !== undefined
        ? String(flow.answers[titleBlock.id] ?? '').trim()
        : `${view.name} — ${new Date().toISOString()}`;

    setSending(true);
    setOutcome(null);
    try {
      const refusal = await container.create(title || `${view.name} response`, properties);
      if (refusal !== null) {
        setOutcome(refusal);
        return;
      }
      setCompletion('saved');
    } catch {
      setOutcome('The response could not be sent. Check the connection and try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      ref={formRef}
      aria-label={view.name}
      className="flex min-w-0 w-full max-w-xl flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void finish();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Checkbox
          label="Save this response"
          checked={saveResponse}
          disabled={sending}
          onChange={(event) => {
            setSaveChoice(event.target.checked);
            setOutcome(null);
          }}
        />
        <Text variant="note" tone="muted" className="wrap-anywhere">
          {saveResponse
            ? 'Adds a child entry to this note.'
            : 'Answers stay in this view. Uploads and history are off.'}
        </Text>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Text variant="caption" tone="muted" role="status">
          {restored ? 'Draft restored. ' : ''}
          {requiredBlocks.length === 0
            ? 'No required answers.'
            : `${String(answeredCount)} of ${String(requiredBlocks.length)} required answered`}
        </Text>
        {requiredBlocks.length === 0 ? null : (
          <progress
            aria-label="Required answers"
            className="h-1.5 w-full"
            max={requiredBlocks.length}
            value={answeredCount}
          />
        )}
      </div>

      {visiblePages.map((page) => (
        <section
          key={page.id}
          aria-labelledby={`form-page-${page.id}`}
          className="flex min-w-0 flex-col gap-4"
        >
          <header className="flex min-w-0 flex-col gap-1 border-b border-divider pb-2">
            <Text variant="h3" as="h2" id={`form-page-${page.id}`} className="wrap-anywhere">
              {page.title}
            </Text>
            {page.description === null ? null : (
              <Text tone="muted" className="wrap-anywhere">
                {page.description}
              </Text>
            )}
          </header>
          {page.blocks.map((block) => (
            <div key={`${block.id}:${String(generation)}`} data-block={block.id} data-enter="">
              <InteractiveBlock
                block={block}
                definition={
                  block.propertyKey === null ? undefined : definitions.get(block.propertyKey)
                }
                value={answers[block.id]}
                error={errors[block.id] ?? null}
                allowInputStorage={saveResponse}
                parentId={container.itemId}
                onValue={(value) => {
                  const next = { ...answersRef.current, [block.id]: value };
                  answersRef.current = next;
                  setAnswers(next);
                  setRestored(false);
                  setErrors((current) =>
                    Object.fromEntries(Object.entries(current).filter(([id]) => id !== block.id)),
                  );
                }}
              />
            </div>
          ))}
        </section>
      ))}

      {outcome === null ? null : (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-divider p-3"
        >
          <Text variant="bodySmall" className="min-w-0 flex-1 wrap-anywhere">
            {outcome}
          </Text>
          {missing === null ? null : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                focusField(missing.id);
              }}
            >
              Go to {missing.text}
            </Button>
          )}
        </div>
      )}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-divider bg-background py-2">
        <Button type="submit" aria-disabled={sending}>
          {sending ? (
            <>
              <span
                aria-hidden
                className="mr-2 inline-block size-3 animate-spin rounded-full border-2 border-current border-r-transparent"
              />
              Sending…
            </>
          ) : saveResponse ? (
            'Send response'
          ) : (
            'Show results'
          )}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={sending || Object.keys(answers).length === 0}
          onClick={clearAnswers}
        >
          Clear answers
        </Button>
      </div>
    </form>
  );
}

function InteractiveBlock({
  block,
  definition,
  value,
  error,
  allowInputStorage,
  parentId,
  onValue,
}: {
  readonly block: FormBlock;
  readonly definition: PropertyDefinition | undefined;
  readonly parentId: string | null;
  readonly value: PropertyValue | undefined;
  readonly error: string | null;
  readonly allowInputStorage: boolean;
  readonly onValue: (value: PropertyValue) => void;
}): ReactNode {
  if (block.kind === 'heading')
    return (
      <Text variant="h4" as="h3" className="wrap-anywhere">
        {block.text}
      </Text>
    );
  if (block.kind === 'paragraph')
    return (
      <Text tone="muted" className="wrap-anywhere">
        {block.text}
      </Text>
    );
  if (definition === undefined || !isKnownPropertyType(definition.type)) {
    return <Text role="alert">“{block.text}” refers to a field that is no longer available.</Text>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <PropertyInput
        item={{
          parentId,
          title: '',
          properties: value === undefined ? {} : { [definition.key]: value },
        }}
        property={{ ...definition, label: block.text, required: block.required }}
        error={error}
        allowInputStorage={allowInputStorage}
        onCommit={onValue}
      />
      {block.help === null ? null : (
        <Text variant="note" tone="muted">
          {block.help}
        </Text>
      )}
    </div>
  );
}
