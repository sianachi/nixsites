import { automations, type AutomationRuleResponse, type NixClient } from '@nix/api-client';
import { Button, Checkbox, Field, Input, Text, focusRing } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

export interface RoutineDraft {
  readonly name: string;
  readonly time: string;
  readonly autoRename: boolean;
  readonly from: string;
  readonly to: string;
}

export function routineDraft(title: string): RoutineDraft {
  return { name: '', time: '09:00', autoRename: false, from: title, to: '' };
}

export function RoutineFields({
  draft,
  onChange,
  disabled,
  canRename,
}: {
  readonly draft: RoutineDraft;
  readonly onChange: (draft: RoutineDraft) => void;
  readonly disabled: boolean;
  readonly canRename: boolean;
}): ReactElement {
  return (
    <fieldset aria-label="Schedule" className="flex min-w-0 flex-col gap-2">
      <Field label="Routine name">
        {(control) => (
          <Input
            {...control}
            value={draft.name}
            maxLength={200}
            required
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, name: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label="Daily time" hint="Uses the time zone in your Nix settings.">
        {(control) => (
          <Input
            {...control}
            type="time"
            value={draft.time}
            required
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, time: event.target.value });
            }}
          />
        )}
      </Field>
      {canRename ? (
        <Checkbox
          label="Allow this exact title change without review"
          checked={draft.autoRename}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...draft, autoRename: event.target.checked });
          }}
        />
      ) : null}
      {canRename && draft.autoRename ? (
        <>
          <Field label="Current title">
            {(control) => (
              <Input
                {...control}
                value={draft.from}
                maxLength={500}
                required
                disabled={disabled}
                onChange={(event) => {
                  onChange({ ...draft, from: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label="New title">
            {(control) => (
              <Input
                {...control}
                value={draft.to}
                maxLength={500}
                required
                disabled={disabled}
                onChange={(event) => {
                  onChange({ ...draft, to: event.target.value });
                }}
              />
            )}
          </Field>
        </>
      ) : null}
      <Text variant="note" tone="muted">
        Nix will ask you to review other changes on this task.
      </Text>
    </fieldset>
  );
}

type RoutineFeed =
  | { readonly status: 'loading' | 'error' }
  | { readonly status: 'ready'; readonly rules: readonly AutomationRuleResponse[] };

const readRoutine = (rule: AutomationRuleResponse) =>
  automations.petRoutineRuleInputSchema.safeParse(rule);

export function PetRoutines({
  client,
  itemId,
  workspaceId,
  revision,
}: {
  readonly client: NixClient;
  readonly itemId: string;
  readonly workspaceId: string;
  readonly revision: number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<RoutineFeed>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void client
      .query(automations.list(workspaceId), { signal: controller.signal, forceRefresh: true })
      .then(({ items }) => {
        if (controller.signal.aborted) return;
        setFeed({
          status: 'ready',
          rules: items.filter((rule) => rule.scopeItemId === itemId && readRoutine(rule).success),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFeed({ status: 'error' });
      });
    return () => {
      controller.abort();
    };
  }, [client, itemId, workspaceId, open, revision, refresh]);

  async function pause(rule: AutomationRuleResponse): Promise<void> {
    if (busy !== null) return;
    const parsed = readRoutine(rule);
    if (!parsed.success) return;
    setFailure(false);
    setBusy(rule.id);
    try {
      const saved = await client.execute(
        automations.update(rule.id, rule.revision, { ...parsed.data, enabled: false }),
      );
      setFeed((shown) =>
        shown.status === 'ready'
          ? { ...shown, rules: shown.rules.map((prior) => (prior.id === saved.id ? saved : prior)) }
          : shown,
      );
    } catch {
      setFailure(true);
      setRefresh((current) => current + 1);
    } finally {
      setBusy(null);
    }
  }

  return (
    <details
      className="min-w-0"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary
        className={`min-h-11 cursor-pointer py-2 any-pointer-coarse:min-h-(--control-lg) ${focusRing}`}
      >
        <Text variant="bodySmall" as="span">
          Scheduled routines
        </Text>
      </summary>
      {open ? (
        <div className="flex min-w-0 flex-col gap-2 pb-2 ps-4">
          {feed.status === 'ready' ? (
            feed.rules.length === 0 ? (
              <Text variant="note" tone="muted">
                No routines scheduled for this task.
              </Text>
            ) : (
              <ul className="flex min-w-0 flex-col gap-2">
                {feed.rules.map((rule) => (
                  <li key={rule.id} className="flex flex-wrap items-baseline justify-between gap-2">
                    <Text variant="note" className="wrap-anywhere">
                      {rule.name} · {rule.enabled ? 'Active' : 'Paused'}
                    </Text>
                    {rule.enabled ? (
                      <Button
                        variant="secondary"
                        aria-label={`Pause ${rule.name}`}
                        disabled={busy !== null}
                        onClick={() => void pause(rule)}
                      >
                        {busy === rule.id ? 'Pausing…' : 'Pause'}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          ) : feed.status === 'loading' ? (
            <Text variant="note" role="status">
              Loading routines…
            </Text>
          ) : (
            <Text variant="note" role="status">
              Could not load routines. Close and open this list to try again.
            </Text>
          )}
          {failure ? (
            <Text variant="note" role="alert">
              The routine could not be paused.
            </Text>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
