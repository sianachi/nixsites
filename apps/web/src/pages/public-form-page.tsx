import { Button, Text } from '@nix/ui';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { isCanceledError, isNixApiError } from '@nix/api-client';

import { useApiClient } from '../api/api-client-provider';
import { PropertyInput, isKnownPropertyType } from '../properties/property-input';
import { type PropertyValue } from '../views/core/container-model';
import { reportFormValidity } from '../views/form/form-validity';
import { claimZenSurface, toggleZenMode, useZenActive } from '@nix/web-foundation/lib/zen-mode';
import {
  publicFormByToken,
  submitPublicForm,
  type PublicForm,
  type PublicFormCondition,
  type PublicFormPage as PublicFormPageContract,
} from './public-form-api';

function matches(
  condition: PublicFormCondition,
  answers: Readonly<Record<string, PropertyValue>>,
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

function visible(
  block: { readonly visibleWhen: readonly PublicFormCondition[] },
  answers: Readonly<Record<string, PropertyValue>>,
): boolean {
  return block.visibleWhen.every((condition) => matches(condition, answers));
}

function empty(value: PropertyValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function resolveFlow(
  pages: readonly PublicFormPageContract[],
  answers: Readonly<Record<string, PropertyValue>>,
): { pages: PublicFormPageContract[]; answers: Record<string, PropertyValue> } {
  const effective: Record<string, PropertyValue> = {};
  const shown: PublicFormPageContract[] = [];
  for (const page of pages) {
    if (!visible(page, effective)) continue;
    const blocks = page.blocks.filter((block) => {
      if (!visible(block, effective)) return false;
      if (block.kind === 'field' && answers[block.id] !== undefined) {
        effective[block.id] = answers[block.id] ?? null;
      }
      return true;
    });
    shown.push({ ...page, blocks });
  }
  return { pages: shown, answers: effective };
}

export function PublicFormPage(): ReactNode {
  useLayoutEffect(claimZenSurface, []);
  const zen = useZenActive();
  const { token = '' } = useParams();
  const client = useApiClient();
  const [form, setForm] = useState<PublicForm | null>(null);
  const [failed, setFailed] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, PropertyValue>>({});
  const answersRef = useRef(answers);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [complete, setComplete] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pendingSubmit = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pageHeaderRef = useRef<HTMLElement>(null);

  useEffect(() => {
    pageHeaderRef.current?.focus();
  }, [pageIndex, complete]);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .query(publicFormByToken(token), { signal: controller.signal, forceRefresh: true })
      .then((loaded) => {
        setForm(loaded);
      })
      .catch((reason: unknown) => {
        if (!isCanceledError(reason)) setFailed(true);
      });
    return () => {
      controller.abort();
      pendingSubmit.current?.abort();
    };
  }, [client, token]);

  const fields = new Map((form?.fields ?? []).map((field) => [field.blockId, field]));

  if (failed) {
    return (
      <PublicFrame>
        <Text variant="h2" as="h1">
          This form is unavailable
        </Text>
        <Text tone="muted" className="wrap-anywhere">
          The link may have expired or been revoked.
        </Text>
      </PublicFrame>
    );
  }
  if (form === null)
    return (
      <PublicFrame>
        <Text tone="muted" className="wrap-anywhere">
          Loading form…
        </Text>
      </PublicFrame>
    );
  if (complete) {
    return (
      <PublicFrame>
        <section
          ref={pageHeaderRef}
          tabIndex={-1}
          aria-live="polite"
          className="flex flex-col gap-2"
        >
          <Text variant="h3" as="h1" className="wrap-anywhere">
            {form.form.confirmationTitle}
          </Text>
          <Text tone="muted" className="wrap-anywhere">
            {form.form.confirmationMessage}
          </Text>
        </section>
      </PublicFrame>
    );
  }

  const pages = resolveFlow(form.form.pages, answers).pages;
  const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];
  if (page === undefined)
    return (
      <PublicFrame>
        <Text tone="muted" className="wrap-anywhere">
          No questions are available.
        </Text>
      </PublicFrame>
    );
  const blocks = page.blocks.filter((block) => visible(block, answers));
  const last = pageIndex >= pages.length - 1;

  function validate(candidates: readonly PublicFormPageContract['blocks'][number][]): boolean {
    if (!reportFormValidity(formRef.current)) return false;
    const currentAnswers = answersRef.current;
    const next = Object.fromEntries(
      candidates
        .filter(
          (block) => block.kind === 'field' && block.required && empty(currentAnswers[block.id]),
        )
        .map((block) => [block.id, 'This answer is required.']),
    );
    setErrors(next);
    if (Object.keys(next).length === 0) return true;
    const firstMissingPage = pages.findIndex((candidate) =>
      candidate.blocks.some((block) => block.id in next),
    );
    if (firstMissingPage >= 0) setPageIndex(firstMissingPage);
    requestAnimationFrame(() =>
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );
    return false;
  }

  async function submit(): Promise<void> {
    if (form === null || pendingSubmit.current !== null) return;
    const currentAnswers = answersRef.current;
    const flow = resolveFlow(form.form.pages, currentAnswers);
    const shown = flow.pages.flatMap((candidate) => candidate.blocks);
    if (!validate(shown)) return;
    const controller = new AbortController();
    pendingSubmit.current = controller;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await client.execute(submitPublicForm(token, flow.answers), { signal: controller.signal });
      setComplete(true);
    } catch (reason) {
      if (!isCanceledError(reason)) {
        setSubmitError(
          isNixApiError(reason) && reason.detail
            ? reason.detail
            : 'The response could not be sent. Your answers are still here. Check the connection and try again.',
        );
      }
    } finally {
      if (pendingSubmit.current === controller) pendingSubmit.current = null;
      setSubmitting(false);
    }
  }

  return (
    <PublicFrame>
      <form
        ref={formRef}
        aria-label={form.name}
        className="flex min-w-0 flex-col gap-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (last) void submit();
          else if (validate(blocks)) setPageIndex((current) => current + 1);
        }}
      >
        <header
          ref={pageHeaderRef}
          tabIndex={-1}
          className="flex min-w-0 flex-col gap-1 border-b border-divider pb-3"
        >
          <Text variant="caption" tone="muted">
            {zen ? null : `${form.name} · `}Page {String(pageIndex + 1)} of {String(pages.length)}
          </Text>
          <Text variant="h3" as="h1" className={zen ? 'sr-only' : 'wrap-anywhere'}>
            {page.title}
          </Text>
          {page.description === null ? null : (
            <Text tone="muted" className={zen ? 'sr-only' : 'wrap-anywhere'}>
              {page.description}
            </Text>
          )}
        </header>
        {blocks.map((block) => {
          if (block.kind === 'heading')
            return (
              <Text key={block.id} variant="h3" as="h2" className="wrap-anywhere">
                {block.text}
              </Text>
            );
          if (block.kind === 'paragraph')
            return (
              <Text key={block.id} tone="muted" className="wrap-anywhere">
                {block.text}
              </Text>
            );
          const field = fields.get(block.id);
          if (field === undefined || !isKnownPropertyType(field.type)) return null;
          return (
            <div key={block.id} className="flex min-w-0 flex-col gap-1">
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
                property={{
                  key: block.id,
                  label: block.text,
                  type: field.type,
                  options: field.options,
                  required: block.required,
                }}
                error={errors[block.id] ?? null}
                onCommit={(value) => {
                  const next = { ...answersRef.current, [block.id]: value };
                  answersRef.current = next;
                  setAnswers(next);
                  setErrors((current) =>
                    Object.fromEntries(Object.entries(current).filter(([id]) => id !== block.id)),
                  );
                }}
              />
            </div>
          );
        })}
        {/* Kept off-screen from people, present for unsophisticated form bots. */}
        <input
          name="website"
          tabIndex={-1}
          autoComplete="off"
          className="hidden"
          aria-hidden="true"
        />
        <Text variant="note" role="alert">
          {submitError}
        </Text>
        <div className="flex flex-wrap gap-2">
          {pageIndex === 0 ? null : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setPageIndex((current) => current - 1);
              }}
            >
              Back
            </Button>
          )}
          <Button type="submit" aria-disabled={submitting}>
            {submitting ? 'Sending…' : last ? 'Send response' : 'Continue'}
          </Button>
        </div>
      </form>
    </PublicFrame>
  );
}

function PublicFrame({ children }: { readonly children: ReactNode }): ReactNode {
  const zen = useZenActive();
  return (
    <main className="mx-auto flex min-h-dvh min-w-0 w-full max-w-2xl flex-col gap-3 px-2 py-4 sm:justify-center sm:px-5 sm:py-8">
      <Button variant="secondary" className="self-end" onClick={toggleZenMode} aria-pressed={zen}>
        {zen ? 'Exit Zen' : 'Enter Zen'}
      </Button>
      <section className="min-w-0 border border-divider bg-surface p-3 shadow-sm sm:p-6">
        {children}
      </section>
    </main>
  );
}
