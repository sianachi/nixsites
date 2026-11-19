import { isNixApiError, linear, type LinearRequestResponse, type NixClient } from '@nix/api-client';
import { Button, Field, Input, Text, focusRing } from '@nix/ui';
import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { usePetSettings } from '@nix/web-platform/api/use-pet-settings';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { LinearLinkSection } from './linear-link-section';

const POLL_MS = 4_000;

const labels = {
  pending: 'Awaiting approval',
  running: 'Reading issue…',
  declined: 'Declined',
  succeeded: 'Lookup complete',
  failed: 'Lookup failed',
  unknown: 'Lookup outcome unknown. Check Linear before asking again.',
  expired: 'Approval request expired',
} satisfies Record<LinearRequestResponse['status'], string>;

function issueLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === 'https://linear.app' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

interface LinearRequestsSectionProps {
  readonly itemId: string;
  readonly onViewComment?: ((commentId: string) => void) | undefined;
  readonly showHandoff?: boolean;
  readonly showLink?: boolean;
}

interface PendingDecision {
  readonly id: string;
  readonly approve: boolean;
}

export function LinearRequestsSection(props: LinearRequestsSectionProps): ReactElement | null {
  const client = useOptionalApiClient();
  return client === null ? null : (
    <>
      {props.showLink !== false ? (
        <LinearLinkSection key={props.itemId} itemId={props.itemId} client={client} />
      ) : null}
      <Requests {...props} client={client} />
    </>
  );
}

function Requests({
  client,
  itemId,
  onViewComment,
  showHandoff = true,
}: LinearRequestsSectionProps & { readonly client: NixClient }) {
  const [requests, setRequests] = useState<readonly LinearRequestResponse[]>([]);
  const [canHandToPet, setCanHandToPet] = useState(false);
  const [enteredId, setEnteredId] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<PendingDecision | null>(null);
  const [sending, setSending] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState(false);

  useEffect(() => {
    if (deciding !== null || sending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The agent can queue a request in a different client while this Details pane is open.
    async function read(): Promise<void> {
      let delay = POLL_MS;
      try {
        if (!document.hidden) {
          const snapshot = await client.query(linear.listRequests(itemId), {
            signal: controller.signal,
            forceRefresh: true,
          });
          if (controller.signal.aborted) return;
          setRequests(snapshot.requests);
          setCanHandToPet(snapshot.canHandToPet);
          setLoadFailed(false);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setRequests([]);
        // The item may have gone away, or the reader's access may have changed.
        if (isNixApiError(error)) {
          if (error.status === 403 || error.status === 404) {
            setCanHandToPet(false);
            setLoadFailed(false);
            return;
          }
          delay = Math.max(POLL_MS, (error.retryAfterSeconds ?? 0) * 1_000);
        }
        setLoadFailed(true);
      }
      timer = setTimeout(() => void read(), delay);
    }

    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, deciding, itemId, sending]);

  async function handToPet(petId: string, issueId: string): Promise<void> {
    setSending(true);
    try {
      const request = await client.execute(linear.handToPet(itemId, petId, issueId));
      setRequests((current) => [request, ...current.filter((row) => row.id !== request.id)]);
      setEnteredId(request.id);
    } finally {
      setSending(false);
    }
  }

  async function decide(id: string, approve: boolean): Promise<void> {
    setDeciding({ id, approve });
    setActionError(false);
    try {
      const updated = await client.execute(linear.decide(itemId, id, approve));
      setRequests((current) => current.map((entry) => (entry.id === id ? updated : entry)));
    } catch {
      setActionError(true);
    } finally {
      setDeciding(null);
    }
  }

  if ((!canHandToPet || !showHandoff) && requests.length === 0 && !loadFailed && !actionError)
    return null;
  return (
    <section aria-label="Linear requests" className="flex min-w-0 flex-col gap-2">
      <Text variant="h5" as="h3">
        Linear requests
      </Text>
      {canHandToPet && showHandoff ? (
        <HandToPetForm busy={sending} disabled={deciding !== null || loadFailed} send={handToPet} />
      ) : null}
      {loadFailed ? (
        <Text variant="note" role="status">
          Could not load Linear requests. Retrying…
        </Text>
      ) : null}
      {actionError ? (
        <Text variant="note" role="alert">
          Could not confirm the decision. Check the request status before trying again.
        </Text>
      ) : null}
      {requests.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {requests.map((request) => {
            const result = request.status === 'succeeded' ? request.result : null;
            const url = result == null ? null : issueLink(result.url);
            const { commentId } = request;
            return (
              <li
                key={request.id}
                data-enter={request.id === enteredId || undefined}
                className="space-y-2 rounded-sm border border-divider p-2"
              >
                <div>
                  <Text variant="bodySmall" className="wrap-anywhere">
                    Read {request.issueId} in Linear
                  </Text>
                  <Text variant="note" tone="muted" className="wrap-anywhere">
                    Requested by {request.requestedBy}
                  </Text>
                </div>
                <Text variant="note" role="status">
                  {requestStatus(request, deciding)}
                </Text>
                {result == null ? null : (
                  <Text variant="note" className="wrap-anywhere">
                    {url === null ? (
                      result.title
                    ) : (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className={`underline ${focusRing}`}
                      >
                        {result.title}
                      </a>
                    )}
                    {' · '}
                    {result.status}
                  </Text>
                )}
                {request.status === 'pending' && request.canDecide ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      disabled={deciding !== null || sending}
                      onClick={() => void decide(request.id, true)}
                    >
                      Approve once
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={deciding !== null || sending}
                      onClick={() => void decide(request.id, false)}
                    >
                      Decline
                    </Button>
                  </div>
                ) : null}
                {commentId == null || onViewComment === undefined ? null : (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      onViewComment(commentId);
                    }}
                  >
                    View comment
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function requestStatus(request: LinearRequestResponse, deciding: PendingDecision | null): string {
  if (deciding?.id === request.id) {
    return deciding.approve && request.petId !== null
      ? 'Waiting for the pet’s next step…'
      : 'Submitting decision…';
  }
  if (request.petId == null) return labels[request.status];
  if (request.status === 'pending') return 'Waiting for approval';
  if (request.status === 'running') return 'Pet working…';
  if (request.status === 'succeeded') {
    return request.commentId == null
      ? 'Lookup complete. The pet could not leave a comment.'
      : 'Next step posted';
  }
  return labels[request.status];
}

function HandToPetForm({
  busy,
  disabled,
  send,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly send: (petId: string, issueId: string) => Promise<void>;
}): ReactElement | null {
  const { saved, error } = usePetSettings();
  const input = useRef<HTMLInputElement>(null);
  const [issueId, setIssueId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const pet = saved?.settings.profiles.find((profile) => profile.id === saved.settings.activePetId);

  if (error !== null) {
    return (
      <Text variant="note" role="status">
        {error}
      </Text>
    );
  }
  if (saved?.settings.enabled !== true || pet === undefined) return null;

  async function submit(petId: string): Promise<void> {
    const issue = issueId.trim();
    if (!issue || busy || disabled) return;
    setProblem(null);
    try {
      await send(petId, issue);
      setIssueId('');
      input.current?.focus();
    } catch (error) {
      setProblem(
        (isNixApiError(error) ? error.detail : undefined) ??
          'Could not confirm the handoff. Check the list before trying again.',
      );
    }
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(pet.id);
      }}
    >
      <Field
        label="Linear issue ID"
        hint={`${pet.name} will check the issue and leave a next step.`}
      >
        {(field) => (
          <Input
            {...field}
            ref={input}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            placeholder="ENG-123"
            readOnly={busy}
            value={issueId}
            onChange={(event) => {
              setIssueId(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="secondary"
        className="self-start"
        disabled={busy || disabled || issueId.trim() === ''}
      >
        {busy ? 'Requesting lookup…' : 'Request Linear lookup'}
      </Button>
      {problem === null ? null : (
        <Text variant="note" role="alert">
          {problem}
        </Text>
      )}
    </form>
  );
}
