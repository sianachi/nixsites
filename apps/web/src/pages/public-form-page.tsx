import { Button, Text } from '@nix/ui';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { isCanceledError, isNixApiError } from '@nix/api-client';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { PropertyInput, isKnownPropertyType } from '@nix/web-collections/properties/property-input';
import { type PropertyValue } from '@nix/web-collections/core/container-model';
import { reportFormValidity } from '@nix/web-views/form/form-validity';
import { ErrorPanel, LoadingPanel } from '@nix/web-foundation/components/states/status-panels';
import { claimZenSurface, toggleZenMode, useZenActive } from '@nix/web-foundation/lib/zen-mode';
import {
  publicFormByToken,
  submitPublicForm,
  type PublicForm,
  type PublicFormCondition,
  type PublicFormPage as PublicFormPageContract,
} from './public-form-api';

const SENT_GRID = 'm-0 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,14rem)_1fr]'; // design-token-exempt: the question column's cap in the sent summary, so long questions wrap instead of crowding answers.

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

const WIDE_TYPES = ['long_text', 'multi_select', 'checkbox'];

function draftKey(token: string): string {
  return `nix.public-form.${token}`;
}

// Reads back only what this visitor typed: known field ids with plain values, nothing else.
function readDraft(
  token: string,
  allowed: ReadonlySet<string>,
): { answers: Record<string, PropertyValue>; page: number } | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(draftKey(token)) ?? 'null');
    if (typeof raw !== 'object' || raw === null || !('answers' in raw)) return null;
    const { answers: stored, page } = raw as { answers: unknown; page?: unknown };
    if (typeof stored !== 'object' || stored === null) return null;
    const answers: Record<string, PropertyValue> = {};
    for (const [id, value] of Object.entries(stored)) {
      const plain =
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
      if (allowed.has(id) && plain) answers[id] = value as PropertyValue;
    }
    return {
      answers,
      page: typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 0,
    };
  } catch {
    return null;
  }
}

function writeDraft(token: string, answers: Record<string, PropertyValue>, page: number): void {
  try {
    if (Object.keys(answers).length === 0) localStorage.removeItem(draftKey(token));
    else localStorage.setItem(draftKey(token), JSON.stringify({ answers, page }));
  } catch {
    // Storage can be blocked; the form still works without a draft.
  }
}

function clearDraft(token: string): void {
  try {
    localStorage.removeItem(draftKey(token));
  } catch {
    // Nothing to clear when storage is blocked.
  }
}

function showAnswer(value: PropertyValue): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return Array.isArray(value) ? value.join(', ') : String(value);
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
  const [restored, setRestored] = useState(false);
  const [sent, setSent] = useState<{
    at: string;
    rows: readonly (readonly [string, string])[];
  } | null>(null);
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
        const draft = readDraft(token, new Set(loaded.fields.map((field) => field.blockId)));
        if (draft !== null && Object.keys(draft.answers).length > 0) {
          answersRef.current = draft.answers;
          setAnswers(draft.answers);
          setPageIndex(draft.page);
          setRestored(true);
        }
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

  useEffect(() => {
    if (form !== null && !complete) writeDraft(token, answers, pageIndex);
  }, [form, complete, token, answers, pageIndex]);

  const fields = new Map((form?.fields ?? []).map((field) => [field.blockId, field]));

  if (failed) {
    return (
      <PublicFrame framed={false}>
        <ErrorPanel
          title="This form is unavailable"
          detail="The link may have expired or been revoked."
        />
      </PublicFrame>
    );
  }
  if (form === null)
    return (
      <PublicFrame framed={false}>
        <LoadingPanel label="the form" />
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
          <SentTick />
          <Text variant="h3" as="h1" className="wrap-anywhere">
            {form.form.confirmationTitle}
          </Text>
          <Text tone="muted" className="wrap-anywhere">
            {form.form.confirmationMessage}
          </Text>
          {sent === null ? null : (
            <>
              <Text variant="note" tone="muted">
                Sent {sent.at}. Your response was received; you can close this page.
              </Text>
              {sent.rows.length === 0 ? null : (
                <>
                  <Text variant="h3" as="h2">
                    What you sent
                  </Text>
                  <dl className={SENT_GRID}>
                    {sent.rows.map(([question, answer]) => (
                      <Fragment key={question}>
                        <Text as="dt" variant="caption" tone="muted">
                          {question}
                        </Text>
                        <dd className="m-0 mb-2 wrap-anywhere sm:mb-0">{answer}</dd>
                      </Fragment>
                    ))}
                  </dl>
                </>
              )}
            </>
          )}
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
  const current = pages.indexOf(page);
  const last = current >= pages.length - 1;
  const missingHere = blocks.filter((block) => block.id in errors);
  const missingElsewhere = pages
    .map((candidate, index) =>
      index !== current && candidate.blocks.some((b) => b.id in errors) ? index + 1 : 0,
    )
    .filter((number) => number > 0);

  function jumpTo(blockId: string): void {
    const wrapper = Array.from(
      formRef.current?.querySelectorAll<HTMLElement>('[data-block]') ?? [],
    ).find((element) => element.dataset.block === blockId);
    wrapper?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }

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
      setSent({
        at: new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
        rows: shown.flatMap((block) => {
          const value = flow.answers[block.id];
          return block.kind !== 'field' || empty(value) || value === false || value === undefined
            ? []
            : [[block.text, showAnswer(value)] as const];
        }),
      });
      clearDraft(token);
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
            {zen ? null : `${form.name} · `}Step {String(current + 1)} of {String(pages.length)}
          </Text>
          <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-divider">
            <div
              data-testid="form-progress"
              className="h-full bg-accent-fill transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${String(((current + 1) / pages.length) * 100)}%` }} // design-token-exempt: a progress bar's fill is a runtime ratio, not a design-scale value.
            />
          </div>
          <Text variant="h3" as="h1" className={zen ? 'sr-only' : 'wrap-anywhere'}>
            {page.title}
          </Text>
          {page.description === null ? null : (
            <Text tone="muted" className={zen ? 'sr-only' : 'wrap-anywhere'}>
              {page.description}
            </Text>
          )}
          {restored && current === 0 && missingHere.length === 0 ? (
            <Text variant="note" tone="muted">
              We kept your earlier answers on this device.
            </Text>
          ) : null}
        </header>
        <div role="alert">
          {missingHere.length === 0 && missingElsewhere.length === 0 ? null : (
            <div className="rounded-md border border-danger p-3">
              {missingHere.length === 0 ? null : (
                <>
                  <Text variant="bodySmall" className="block font-semibold">
                    {missingHere.length === 1
                      ? '1 answer needs your attention'
                      : `${String(missingHere.length)} answers need your attention`}
                  </Text>
                  <ul className="m-0 list-disc pl-5">
                    {missingHere.map((block) => (
                      <li key={block.id}>
                        <button
                          type="button"
                          className="min-h-11 text-left underline wrap-anywhere"
                          onClick={() => {
                            jumpTo(block.id);
                          }}
                        >
                          {block.kind === 'field' ? block.text : ''}: {errors[block.id]}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {missingElsewhere.length === 0 ? null : (
                <Text variant="bodySmall" className="block">
                  Also needs an answer on page {missingElsewhere.join(', ')}.
                </Text>
              )}
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {blocks.map((block) => {
            if (block.kind === 'heading')
              return (
                <Text
                  key={block.id}
                  variant="h3"
                  as="h2"
                  className="wrap-anywhere md:col-span-full"
                >
                  {block.text}
                </Text>
              );
            if (block.kind === 'paragraph')
              return (
                <Text key={block.id} tone="muted" className="wrap-anywhere md:col-span-full">
                  {block.text}
                </Text>
              );
            const field = fields.get(block.id);
            if (field === undefined || !isKnownPropertyType(field.type)) return null;
            return (
              <div
                key={block.id}
                data-block={block.id}
                className={`flex min-w-0 flex-col gap-1${WIDE_TYPES.includes(field.type) ? ' md:col-span-full' : ''}`}
              >
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
                {block.help === null ? null : (
                  <Text variant="note" tone="muted">
                    {block.help}
                  </Text>
                )}
              </div>
            );
          })}
        </div>
        {/* Kept off-screen from people, present for unsophisticated form bots. */}
        <input
          name="website"
          tabIndex={-1}
          autoComplete="off"
          className="hidden"
          aria-hidden="true"
        />
        <div role="alert">
          {submitError === null ? null : (
            <Text variant="bodySmall" className="block rounded-md border border-divider p-3">
              {submitError}
            </Text>
          )}
        </div>
        <div className="sticky bottom-0 z-10 -mx-3 flex flex-col gap-1.5 border-t border-divider bg-background px-3 py-2 sm:-mx-6 sm:px-6">
          <div className="flex flex-wrap justify-between gap-2">
            {pageIndex === 0 ? (
              <span />
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setErrors({});
                  setSubmitError(null);
                  setPageIndex((index) => index - 1);
                }}
              >
                Back
              </Button>
            )}
            <Button type="submit" aria-disabled={submitting} className="min-w-36">
              {submitting ? (
                <>
                  <span
                    aria-hidden="true"
                    className="mr-2 inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
                  />
                  Sending…
                </>
              ) : last ? (
                submitError === null ? (
                  'Send response'
                ) : (
                  'Try again'
                )
              ) : (
                'Continue'
              )}
            </Button>
          </div>
          <Text variant="note" tone="muted" className="text-right">
            {blocks.some((block) => block.kind === 'field' && block.required)
              ? '* required · '
              : ''}
            Answers are saved on this device as you go
          </Text>
        </div>
      </form>
    </PublicFrame>
  );
}

function PublicFrame({
  children,
  framed = true,
}: {
  readonly children: ReactNode;
  readonly framed?: boolean;
}): ReactNode {
  const zen = useZenActive();
  return (
    <main className="mx-auto flex min-h-dvh min-w-0 w-full max-w-2xl lg:max-w-4xl flex-col gap-3 px-2 py-4 sm:justify-center sm:px-5 sm:py-8">
      <Button variant="subtle" className="self-end" onClick={toggleZenMode} aria-pressed={zen}>
        {zen ? 'Exit Zen' : 'Enter Zen'}
      </Button>
      <section
        className={framed ? 'min-w-0 rounded-md border border-divider p-3 sm:p-6' : 'min-w-0'}
      >
        {children}
      </section>
    </main>
  );
}

function SentTick(): ReactNode {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setDrawn(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <svg viewBox="0 0 56 56" aria-hidden="true" className="size-14 text-accent">
      {['M28 3a25 25 0 1 1 0 50a25 25 0 1 1 0-50', 'M16 29l8 8 16-17'].map((d) => (
        <path
          key={d}
          d={d}
          pathLength={1}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeDasharray={1}
          strokeDashoffset={drawn ? 0 : 1}
          className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
        />
      ))}
    </svg>
  );
}
