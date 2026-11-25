import type { PetPlanSharingQuestion } from '@nix/api-client';
import { Button, Field, Input, Text } from '@nix/ui';
import { useEffect, useRef, type ReactElement } from 'react';

/** Owner sharing controls stay outside generated content. */
export function PetSharingQuestion({
  question,
  busy,
  onDecision,
}: {
  readonly question: PetPlanSharingQuestion;
  readonly busy: boolean;
  readonly onDecision: (approve: boolean) => void;
}): ReactElement {
  const known = question.recipient.connectionRevision !== 'unknown';
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body) region.current?.focus();
  }, []);
  const scope =
    (question.sourceScope.readOnlyWorkspaceIds?.length ?? 0) > 0
      ? `${String(question.sourceScope.readOnlyWorkspaceIds?.length)} selected read-only workspaces`
      : question.sourceScope.kind === 'workspace'
        ? 'Current readable workspace'
        : question.sourceScope.kind === 'subtree'
          ? 'Selected note and its readable children'
          : `${String(question.sourceScope.itemIds?.length ?? 0)} selected sources`;
  return (
    <section
      ref={region}
      tabIndex={-1}
      aria-label="Share context with the companion"
      className="flex min-w-0 flex-col gap-2 rounded-md border border-divider p-3"
    >
      <Text as="h4" variant="h5">
        May I use this context?
      </Text>
      <Text>{question.message}</Text>
      <Field label="Context">{(control) => <Input {...control} readOnly value={scope} />}</Field>
      <Field label="Provider">
        {(control) => <Input {...control} readOnly value={question.recipient.provider} />}
      </Field>
      <Field label="Destination">
        {(control) => <Input {...control} readOnly value={question.recipient.destination} />}
      </Field>
      {!known ? (
        <Text variant="note">
          Reconnect the selected provider before sharing. Its recipient could not be confirmed.
        </Text>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !known || question.decisionNonce == null}
          onClick={() => {
            onDecision(true);
          }}
        >
          <span className="grid">
            <span aria-hidden="true" className="invisible col-start-1 row-start-1">
              Saving choice…
            </span>
            <span className="col-start-1 row-start-1">{busy ? 'Saving choice…' : 'Continue'}</span>
          </span>
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            onDecision(false);
          }}
        >
          Keep context private
        </Button>
      </div>
    </section>
  );
}
