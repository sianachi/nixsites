import {
  isNixApiError,
  petPlans,
  type CommandEndpoint,
  type NixClient,
  type PetPlanResponse,
} from '@nix/api-client';
import { Button, Checkbox, Field, Input, Select, Text, Textarea, Toast, focusRing } from '@nix/ui';
import { ValueFields } from '@nix/web-pets/pets/approval/value-fields';
import { READ_ONLY_OPERATION_NAMES } from '@nix/structure-spec';
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  hasTypedPlanPreview,
  validPlanPreview,
  PetPlanStepPreview,
  PetPlanTargetLinks,
} from './pet-plan-preview';
import { PetPlanReceipt } from './pet-plan-receipt';

type Plan = NonNullable<PetPlanResponse['plan']>;
type Step = Plan['steps'][number];
type EditableField = Step['fields'][number];
const readCapabilities = new Set<string>(
  READ_ONLY_OPERATION_NAMES.filter((operation) => operation !== 'remember').map(
    (operation) => `workspace.${operation}`,
  ),
);

interface Props {
  readonly client: NixClient;
  readonly run: PetPlanResponse;
  readonly onUpdate: (run: PetPlanResponse) => void;
  readonly hideBrief?: boolean;
  readonly onContinue?: ((run: PetPlanResponse) => Promise<void>) | undefined;
  readonly continueLabel?: string;
  readonly reviewAllowed?: boolean;
  readonly hideCancel?: boolean;
  readonly onActionStart?: (() => void) | undefined;
  readonly onActionEnd?: (() => void) | undefined;
}

export function PetPlanCard(props: Props): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const focusIntent = useRef<{ readonly owned: boolean; movedOutside: boolean } | null>(null);
  const identity = `${props.run.id}:${props.run.plan?.reviewDigest ?? ''}:${props.run.question?.id ?? ''}`;
  useLayoutEffect(() => {
    if (restoreFocus.current) {
      root.current?.querySelector<HTMLElement>('section')?.focus();
      restoreFocus.current = false;
    }
  });
  useEffect(() => {
    const moved = (event: FocusEvent) => {
      if (
        focusIntent.current !== null &&
        event.target instanceof HTMLElement &&
        event.target !== document.body &&
        root.current?.contains(event.target) !== true
      )
        focusIntent.current.movedOutside = true;
    };
    document.addEventListener('focusin', moved);
    return () => {
      document.removeEventListener('focusin', moved);
    };
  }, []);
  return (
    <div ref={root} className="min-w-0">
      <PlanReview
        key={identity}
        {...props}
        onActionStart={() => {
          focusIntent.current = {
            owned: root.current?.contains(document.activeElement) ?? false,
            movedOutside: false,
          };
        }}
        onActionEnd={() => {
          const intent = focusIntent.current;
          if (intent?.owned === true && !intent.movedOutside) {
            restoreFocus.current = true;
            root.current?.querySelector<HTMLElement>('section')?.focus();
          }
          focusIntent.current = null;
        }}
        onUpdate={(run) => {
          restoreFocus.current =
            focusIntent.current?.owned === true && !focusIntent.current.movedOutside;
          props.onUpdate(run);
        }}
      />
    </div>
  );
}

function PlanReview({
  client,
  run,
  onUpdate,
  hideBrief = false,
  onContinue,
  continueLabel = 'Continue',
  reviewAllowed = true,
  hideCancel = false,
  onActionStart,
  onActionEnd,
}: Props): ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [held, setHeld] = useState(false);
  const [editingStep, setEditingStep] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [answer, setAnswer] = useState('');
  const [nativeReady, setNativeReady] = useState<Readonly<Record<string, boolean>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);
  const requestIds = useRef(new Map<string, string>());
  const region = useRef<HTMLElement>(null);
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (changing) feedbackInput.current?.focus();
  }, [changing]);
  const plan = run.plan;
  const activeSteps = plan?.steps.filter((step) => step.status !== 'cancelled') ?? [];
  const readPhase =
    activeSteps.length > 0 && activeSteps.every((step) => readCapabilities.has(step.capability));
  const progressSteps = readPhase ? activeSteps : (plan?.steps ?? []);
  const decisionLabel = readPhase ? 'Read shared sources' : continueLabel;
  const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);
  const reviewable = run.status === 'waiting_for_approval' && plan?.status === 'awaiting_review';
  const validPreview =
    plan != null &&
    activeSteps.length > 0 &&
    plan.steps.length <= 12 &&
    activeSteps.every(
      (step) =>
        step.effect.description.trim() !== '' &&
        typeof step.effect.parameters === 'object' &&
        step.effect.parameters !== null &&
        Object.keys(step.effect.parameters).length > 0 &&
        validPlanPreview(step),
    );
  const completed = progressSteps.filter(
    (step) => step.status === 'applied' || step.status === 'undone',
  ).length;
  const undoable = readPhase
    ? undefined
    : plan?.steps.findLast((step) => step.status === 'applied' && step.undoId != null);
  const previousStatuses = useRef(new Map(run.plan?.steps.map((step) => [step.id, step.status])));
  const observeReceipts = useEffectEvent(() => {
    const applied = plan?.steps.findLast(
      (step) =>
        step.status === 'applied' &&
        step.undoId != null &&
        previousStatuses.current.get(step.id) !== 'applied',
    );
    previousStatuses.current = new Map(plan?.steps.map((step) => [step.id, step.status]));
    if (applied !== undefined) setNotice(`Completed ${applied.effect.description}.`);
  });
  useEffect(() => {
    observeReceipts();
  }, [run.revision]);
  const undoFromKeyboard = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target;
    if (
      (!event.ctrlKey && !event.metaKey) ||
      event.shiftKey ||
      event.key.toLowerCase() !== 'z' ||
      !region.current?.contains(document.activeElement) ||
      ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
        !target.readOnly) ||
      (target instanceof HTMLElement && target.isContentEditable) ||
      busy !== null ||
      plan == null ||
      undoable === undefined
    )
      return;
    event.preventDefault();
    void perform(
      `undo:${undoable.id}`,
      petPlans.undo(run.workspaceId, run.id, plan.id, undoable.id, {
        expectedRunRevision: run.revision,
        requestId: requestId(`undo:${undoable.id}`),
      }),
    );
  });
  useEffect(() => {
    document.addEventListener('keydown', undoFromKeyboard);
    return () => {
      document.removeEventListener('keydown', undoFromKeyboard);
    };
  }, []);

  function requestId(action: string, payload?: unknown): string {
    const identity = JSON.stringify([
      action,
      run.revision,
      plan?.id,
      plan?.version,
      plan?.reviewDigest,
      run.question?.id,
      payload,
    ]);
    const saved = requestIds.current.get(identity);
    if (saved !== undefined) return saved;
    const next = crypto.randomUUID();
    requestIds.current.set(identity, next);
    return next;
  }

  async function perform(
    action: string,
    command: CommandEndpoint<PetPlanResponse> | (() => Promise<void>),
  ): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    onActionStart?.();
    setBusy(action);
    setError('');
    try {
      if (typeof command === 'function') await command();
      else {
        onUpdate(await client.execute(command));
        if (action.startsWith('undo:')) setNotice('Undid the reviewed change.');
      }
    } catch (reason) {
      setError(
        isNixApiError(reason)
          ? (reason.detail ?? reason.message)
          : 'This request could not be confirmed. Refresh the plan before trying again.',
      );
      setHeld(true);
    } finally {
      lock.current = false;
      setBusy(null);
      onActionEnd?.();
    }
  }

  async function refresh(): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    setBusy('refresh');
    try {
      onUpdate(
        await client.query(petPlans.getRun(run.workspaceId, run.id), { forceRefresh: true }),
      );
      setError('');
      setHeld(false);
    } catch {
      setError('The latest plan could not be loaded. No further work was requested.');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  return (
    <section
      ref={region}
      tabIndex={-1}
      aria-label="Companion plan"
      className="flex min-w-0 flex-col gap-3 rounded-card border border-divider p-3 outline-none motion-safe:animate-in motion-safe:fade-in"
    >
      {!hideBrief ? (
        <Text as="h3" variant="h5">
          {run.brief}
        </Text>
      ) : null}
      <Text variant="note" tone="muted">
        {run.status.replaceAll('_', ' ')}
      </Text>
      <Text variant="note" tone="muted">
        Context:{' '}
        {run.sourceScope.kind === 'workspace'
          ? 'the current readable workspace'
          : run.sourceScope.kind === 'subtree'
            ? 'the selected item and its readable children'
            : `${String(run.sourceScope.itemIds?.length ?? 0)} selected sources`}
        {(run.sourceScope.readOnlyWorkspaceIds?.length ?? 0) > 0
          ? `, with ${String(run.sourceScope.readOnlyWorkspaceIds?.length)} additional read-only workspaces`
          : ''}
        .
      </Text>
      {run.question != null ? (
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (run.question == null || !answer.trim()) return;
            void perform(
              'answer',
              petPlans.answer(run.workspaceId, run.id, {
                expectedRunRevision: run.revision,
                questionId: run.question.id,
                answer,
                requestId: requestId('answer', answer),
              }),
            );
          }}
        >
          <Field label={run.question.text} required>
            {(field) => (
              <Textarea
                {...field}
                value={answer}
                disabled={busy !== null}
                onChange={(event) => {
                  setAnswer(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <div>
            <Button type="submit" disabled={busy !== null || !answer.trim()}>
              {busy === 'answer' ? 'Sending answer…' : 'Send answer'}
            </Button>
          </div>
          <Text variant="note" tone="muted">
            This answer helps prepare the plan. Review the changes before continuing.
          </Text>
        </form>
      ) : null}
      {(run.observations?.length ?? 0) > 0 ? (
        <section aria-label="Discovery results" className="flex min-w-0 flex-col gap-3">
          {run.observations?.map((observation) => (
            <div
              key={observation.id}
              role="group"
              aria-label={observation.description}
              className="flex min-w-0 flex-col gap-2"
            >
              <Text as="h4" variant="h5">
                {observation.description}
              </Text>
              {observation.receiptView == null ? null : (
                <PetPlanReceipt view={observation.receiptView} />
              )}
            </div>
          ))}
        </section>
      ) : null}
      {plan == null ? null : (
        <>
          <Text>{plan.summary}</Text>
          <Text variant="note" tone="muted">
            {readPhase
              ? 'This decision allows only the reads below. Any later changes need a separate review.'
              : 'One decision covers the exact changes below.'}
          </Text>
          <ol className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
            {plan.steps.map((step, index) => (
              <li key={step.id}>
                <div
                  role="group"
                  aria-label={step.effect.description}
                  className="flex min-w-0 flex-col gap-2 border-t border-divider p-3"
                >
                  <Text as="h4" variant="h5">
                    {String(index + 1)}. {step.effect.description}
                  </Text>
                  <Text variant="note" tone="muted">
                    {stepStatus(step.status)}
                  </Text>
                  {readPhase && step.status === 'cancelled' ? null : (
                    <PetPlanStepPreview
                      step={step}
                      onReady={(ready) => {
                        setNativeReady((current) =>
                          current[step.id] === ready ? current : { ...current, [step.id]: ready },
                        );
                      }}
                      onRefresh={() => {
                        void perform(
                          'revise',
                          petPlans.revise(run.workspaceId, run.id, {
                            expectedRunRevision: run.revision,
                            planVersion: plan.version,
                            requestId: requestId('refresh-native', step.id),
                          }),
                        );
                      }}
                    />
                  )}
                  <PetPlanTargetLinks step={step} workspaceId={run.workspaceId} />
                  {(readPhase && step.status === 'cancelled') || hasTypedPlanPreview(step)
                    ? null
                    : step.fields.map((field) => (
                        <div
                          key={field.id}
                          role="group"
                          aria-label={`${field.label} values`}
                          className="grid min-w-0 gap-2 @lg:grid-cols-2"
                        >
                          {field.currentValue === undefined ? null : (
                            <ValueFields
                              label={`Current ${field.label}`}
                              value={field.currentValue}
                            />
                          )}
                          <ValueFields label={`Proposed ${field.label}`} value={field.value} />
                        </div>
                      ))}
                  {step.receiptView == null ? (
                    step.receipt == null ? null : (
                      <Text className="whitespace-pre-wrap">{step.receipt}</Text>
                    )
                  ) : (
                    <PetPlanReceipt view={step.receiptView} />
                  )}
                  {!readPhase && step.undoId != null && step.status === 'applied' ? (
                    <div>
                      <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => {
                          void perform(
                            `undo:${step.id}`,
                            petPlans.undo(run.workspaceId, run.id, plan.id, step.id, {
                              expectedRunRevision: run.revision,
                              requestId: requestId(`undo:${step.id}`),
                            }),
                          );
                        }}
                      >
                        Undo {step.effect.description}
                      </Button>
                    </div>
                  ) : null}
                  {reviewable &&
                  !readPhase &&
                  step.status !== 'cancelled' &&
                  step.fields.some(editable) ? (
                    editingStep === step.id ? (
                      <PlanFieldEditor
                        key={step.id}
                        step={step}
                        disabled={busy !== null}
                        onCancel={() => {
                          setEditingStep(null);
                          region.current?.focus();
                        }}
                        onSave={(fieldEdits) => {
                          void perform(
                            'revise',
                            petPlans.revise(run.workspaceId, run.id, {
                              expectedRunRevision: run.revision,
                              planVersion: plan.version,
                              fieldEdits,
                              requestId: requestId('revise', fieldEdits),
                            }),
                          );
                        }}
                      />
                    ) : (
                      <div>
                        <Button
                          variant="ghost"
                          disabled={busy !== null || editingStep !== null || held}
                          onClick={() => {
                            setEditingStep(step.id);
                          }}
                        >
                          Edit values
                        </Button>
                      </div>
                    )
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <progress
            aria-label="Plan progress"
            max={progressSteps.length}
            value={completed}
            className="h-2 w-full accent-accent"
          />
          <div role="status" aria-label="Plan progress summary">
            <Text variant="note">
              {String(completed)} of {String(progressSteps.length)}{' '}
              {readPhase ? 'reads' : 'changes'} completed
            </Text>
          </div>
          {run.status === 'waiting_for_handoff' ? (
            <Text variant="note">
              Keep this conversation open to continue the step that needs your device. The remaining
              work is paused.
            </Text>
          ) : null}
          {plan.steps.some((step) => step.status === 'unknown') ? (
            <Text variant="note">
              A change may have reached its destination. Inspect its result before preparing another
              plan. Nix will not repeat it automatically.
            </Text>
          ) : null}
          {reviewable ? (
            <>
              {!validPreview ? (
                <Text role="alert" variant="note">
                  The complete preview is unavailable. Prepare a fresh plan before continuing.
                </Text>
              ) : null}
              {changing ? (
                <form
                  className="flex min-w-0 flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!feedback.trim()) return;
                    void perform(
                      'revise',
                      petPlans.revise(run.workspaceId, run.id, {
                        expectedRunRevision: run.revision,
                        planVersion: plan.version,
                        feedback,
                        requestId: requestId('feedback', feedback),
                      }),
                    );
                  }}
                >
                  <Field label="What should change?" required>
                    {(field) => (
                      <Textarea
                        {...field}
                        ref={feedbackInput}
                        required
                        maxLength={2000}
                        value={feedback}
                        onChange={(event) => {
                          setFeedback(event.currentTarget.value);
                        }}
                        disabled={busy !== null}
                      />
                    )}
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy !== null || !feedback.trim()}>
                      Prepare a new plan
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        setChanging(false);
                        region.current?.focus();
                      }}
                    >
                      Keep this plan
                    </Button>
                  </div>
                </form>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    busy !== null ||
                    held ||
                    editingStep !== null ||
                    changing ||
                    !validPreview ||
                    !reviewAllowed ||
                    activeSteps.some(
                      (step) => step.capability === 'canvas.edit' && nativeReady[step.id] !== true,
                    )
                  }
                  onClick={() => {
                    void perform(
                      'continue',
                      onContinue === undefined
                        ? petPlans.decide(run.workspaceId, run.id, plan.id, {
                            expectedRunRevision: run.revision,
                            planVersion: plan.version,
                            reviewDigest: plan.reviewDigest,
                            approve: true,
                            requestId: requestId('continue'),
                          })
                        : () => onContinue(run),
                    );
                  }}
                >
                  <span className="grid">
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                      {decisionLabel}
                    </span>
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                      Continuing…
                    </span>
                    <span className="col-start-1 row-start-1">
                      {busy === 'continue' ? 'Continuing…' : decisionLabel}
                    </span>
                  </span>
                </Button>
                {!changing && !readPhase ? (
                  <Button
                    variant="ghost"
                    disabled={busy !== null || editingStep !== null}
                    onClick={() => {
                      setChanging(true);
                    }}
                  >
                    Change plan
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      )}
      {run.results
        .filter(
          (result) =>
            !plan?.steps.some(
              (step) =>
                step.receipt === result.text ||
                step.receiptView?.text === result.text ||
                step.receiptView?.summary === result.text,
            ),
        )
        .map((result) => (
          <Text key={result.id} className="whitespace-pre-wrap">
            {result.text}
          </Text>
        ))}
      {run.failure == null ? null : (
        <Text role="alert" variant="note">
          {run.failure.message}
        </Text>
      )}
      {error ? (
        <Text role="alert" variant="note">
          {error}
        </Text>
      ) : null}
      {notice === null ? null : (
        <Toast
          message={notice}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- This disables Toast's mount focus.
          autoFocus={false}
          returnFocusRef={region}
          onDismiss={() => {
            setNotice(null);
          }}
          {...(undoable === undefined || plan == null
            ? {}
            : {
                action: {
                  label: 'Undo',
                  onAction: () => {
                    void perform(
                      `undo:${undoable.id}`,
                      petPlans.undo(run.workspaceId, run.id, plan.id, undoable.id, {
                        expectedRunRevision: run.revision,
                        requestId: requestId(`undo:${undoable.id}`),
                      }),
                    );
                  },
                },
              })}
        />
      )}
      {held ? (
        <div>
          <Button variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh plan'}
          </Button>
        </div>
      ) : null}
      {!terminal && !hideCancel ? (
        <div>
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              void perform(
                'cancel',
                petPlans.cancel(run.workspaceId, run.id, {
                  expectedRunRevision: run.revision,
                  requestId: requestId('cancel'),
                }),
              );
            }}
          >
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel plan'}
          </Button>
        </div>
      ) : null}
      {run.anchorItemId == null ? null : (
        <a
          className={`inline-flex min-h-(--control-lg) w-fit items-center underline ${focusRing}`}
          href={`/w/${run.workspaceId}?item=${run.anchorItemId}`}
        >
          Open the related item
        </a>
      )}
    </section>
  );
}

function stepStatus(status: string): string {
  switch (status) {
    case 'pending':
      return 'Ready after you continue';
    case 'claimed':
      return 'Waiting to start';
    case 'applying':
      return 'Applying this change…';
    case 'applied':
      return 'Completed';
    case 'undone':
      return 'Undone';
    case 'unknown':
      return 'Outcome needs inspection';
    case 'partial':
      return 'Partly completed. Remaining work stopped.';
    case 'stale':
      return 'The preview changed. Review a fresh plan.';
    case 'refused':
      return 'This change was refused. Remaining work stopped.';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

function editable(field: EditableField): boolean {
  return (
    ['text', 'multiline', 'number', 'boolean', 'date', 'choice'].includes(field.kind) &&
    (typeof field.value === 'string' ||
      typeof field.value === 'number' ||
      typeof field.value === 'boolean')
  );
}

function PlanFieldEditor({
  step,
  disabled,
  onCancel,
  onSave,
}: {
  readonly step: Step;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onSave: (
    edits: readonly {
      readonly stepId: string;
      readonly fieldId: string;
      readonly value: EditableField['value'];
    }[],
  ) => void;
}): ReactElement {
  const [values, setValues] = useState<Record<string, EditableField['value']>>(() =>
    Object.fromEntries(step.fields.filter(editable).map((field) => [field.id, field.value])),
  );
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input,textarea,select')?.focus();
  }, []);
  return (
    <form
      ref={form}
      aria-label={`Edit ${step.effect.description}`}
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(
          step.fields.filter(editable).map((field) => ({
            stepId: step.id,
            fieldId: field.id,
            value: values[field.id] ?? field.value,
          })),
        );
      }}
    >
      {step.fields.filter(editable).map((field) => (
        <Field
          key={field.id}
          label={field.label}
          {...(field.help == null ? {} : { hint: field.help })}
          required={field.required}
        >
          {(control) => {
            const value = values[field.id] ?? field.value;
            const set = (next: EditableField['value']) => {
              setValues((current) => ({ ...current, [field.id]: next }));
            };
            if (field.kind === 'boolean')
              return (
                <Checkbox
                  {...control}
                  disabled={disabled}
                  checked={value === true}
                  onChange={(event) => {
                    set(event.currentTarget.checked);
                  }}
                />
              );
            if (field.kind === 'choice')
              return (
                <Select
                  {...control}
                  disabled={disabled}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => {
                    set(event.currentTarget.value);
                  }}
                >
                  {field.choices?.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </Select>
              );
            if (field.kind === 'multiline')
              return (
                <Textarea
                  {...control}
                  required={field.required}
                  disabled={disabled}
                  rows={4}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => {
                    set(event.currentTarget.value);
                  }}
                />
              );
            return (
              <Input
                {...control}
                required={field.required}
                disabled={disabled}
                type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'}
                {...(field.kind === 'number' ? { step: 'any' } : {})}
                value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                onChange={(event) => {
                  set(
                    field.kind === 'number'
                      ? event.currentTarget.value === ''
                        ? ''
                        : Number(event.currentTarget.value)
                      : event.currentTarget.value,
                  );
                }}
              />
            );
          }}
        </Field>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={disabled}>
          Preview these values
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={onCancel}>
          Cancel editing
        </Button>
      </div>
    </form>
  );
}
