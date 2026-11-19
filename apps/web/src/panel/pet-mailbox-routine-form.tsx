import { automations, petConnections, type PetServiceConnection } from '@nix/api-client';
import { Button, Field, Input, Select, Text, Textarea, focusRing } from '@nix/ui';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useEffect, useState, type ReactElement, type SubmitEvent } from 'react';

function watchProvider(connection: PetServiceConnection): 'gmail' | 'outlook-mail' | undefined {
  if (
    connection.provider === 'google' &&
    connection.resourceKind === 'gmail-label' &&
    ['gmail.checkpoint', 'gmail.list-changes', 'gmail.get-message'].every((action) =>
      connection.actions.includes(action),
    )
  ) {
    return 'gmail';
  }
  if (
    connection.provider === 'microsoft' &&
    connection.resourceKind === 'folder' &&
    ['outlook-mail.poll-folder', 'outlook-mail.get-message'].every((action) =>
      connection.actions.includes(action),
    )
  ) {
    return 'outlook-mail';
  }
}

function mailboxLabel(connection: PetServiceConnection): string {
  return `${connection.provider === 'google' ? 'Gmail' : 'Outlook'} · ${connection.resourceId}`;
}

export function PetMailboxRoutineForm({
  workspaceId,
  itemId,
  disabled = false,
  onSaved,
}: {
  readonly workspaceId: string;
  readonly itemId: string;
  readonly disabled?: boolean;
  readonly onSaved?: () => void;
}): ReactElement | null {
  const client = useApiClient();
  const [selection, setSelection] = useState<{
    readonly workspaceId: string;
    readonly connections: PetServiceConnection[];
  } | null>(null);
  const connections = selection?.workspaceId === workspaceId ? selection.connections : [];
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'saved' | 'failed' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .query(petConnections.list(workspaceId), { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setSelection({
            workspaceId,
            connections: data.enabled ? data.connections.filter(watchProvider) : [],
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setSelection(null);
      });
    return () => {
      controller.abort();
    };
  }, [client, workspaceId]);

  async function save(form: HTMLFormElement): Promise<void> {
    const fields = new FormData(form);
    const choice = connections.find((connection) => connection.id === fields.get('mailbox'));
    const provider = choice && watchProvider(choice);
    if (!choice || !provider) {
      setStatus('failed');
      return;
    }
    const rule = automations.petMailboxRoutineRuleInputSchema.safeParse({
      name: `Watch ${mailboxLabel(choice)}`.slice(0, 200),
      enabled: true,
      scopeItemId: itemId,
      trigger: { type: 'schedule', freq: 'daily', interval: 1, time: fields.get('time') },
      conditions: [],
      actions: [
        {
          type: 'poll_pet_mailbox',
          provider,
          connectionId: choice.id,
          connectionRevision: choice.revision,
          resourceId: choice.resourceId,
          brief: fields.get('brief'),
          includeTargetText: false,
        },
      ],
    });
    if (!rule.success) {
      setStatus('failed');
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await client.execute(automations.create(workspaceId, rule.data));
      setStatus('saved');
      form.reset();
      onSaved?.();
    } catch {
      setStatus('failed');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    void save(event.currentTarget);
  }

  if (connections.length === 0) return null;

  return (
    <details className="min-w-0">
      <summary className={`cursor-pointer ${focusRing}`}>
        <Text as="span" variant="bodySmall">
          Watch a mailbox
        </Text>
      </summary>
      <form className="flex min-w-0 flex-col gap-2 pt-2" onSubmit={submit}>
        <Field label="Mailbox label or folder">
          {(control) => (
            <Select {...control} name="mailbox" required disabled={disabled || busy}>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {mailboxLabel(connection)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Daily time" hint="Uses the time zone in your Nix settings.">
          {(control) => (
            <Input
              {...control}
              name="time"
              type="time"
              defaultValue="09:00"
              required
              disabled={disabled || busy}
            />
          )}
        </Field>
        <Field label="What should your pet do with new mail?">
          {(control) => (
            <Textarea
              {...control}
              name="brief"
              rows={3}
              maxLength={2_000}
              required
              disabled={disabled || busy}
            />
          )}
        </Field>
        <Text variant="note" tone="muted">
          The first check sets a starting point for new mail. Review message reads and replies from
          this task.
        </Text>
        <Button type="submit" disabled={disabled || busy}>
          {busy ? 'Saving…' : 'Start watching'}
        </Button>
        {status ? (
          <Text variant="note" role={status === 'failed' ? 'alert' : 'status'}>
            {status === 'failed' ? 'Could not save the mailbox watch.' : 'Mailbox watch scheduled.'}
          </Text>
        ) : null}
      </form>
    </details>
  );
}
