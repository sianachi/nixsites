import { Button, Field, Text, Textarea } from '@nix/ui';
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';

/**
 * The one frame a write wears while it waits for the owner, for the pet's cards and for a
 * generated component's alike: a hairline group named by the operation and its target, so two
 * waiting cards never share a heading, and the decision controls beneath. It is flat
 * (no fill, no shadow) and tight (p-3), the way a bordered group sits in a narrow chat log.
 *
 * Nothing in the body is folded while the card is pending (security fix S1): the frame only
 * arranges what its callers pass.
 */
export function ApprovalFrame({
  heading,
  anchor = false,
  children,
  actions,
}: {
  /** The first thing waiting on the owner: the chat scrolls to its top. */
  readonly anchor?: boolean;
  /** The preview's headline: the operation and what it acts on. */
  readonly heading: string;
  readonly children: ReactNode;
  /** The action row, given the heading's id so each button can be described by it. */
  readonly actions: (headingId: string) => ReactNode;
}): ReactElement {
  const headingId = useId();
  return (
    <div
      role="group"
      data-pet-latest-message={anchor ? '' : undefined}
      aria-labelledby={headingId}
      className="my-1 flex min-w-0 flex-col gap-2 rounded-md border border-divider p-3 wrap-anywhere"
    >
      <Text as="h3" variant="h5" id={headingId}>
        {heading}
      </Text>
      {children}
      {actions(headingId)}
    </div>
  );
}

/** The action names say what will happen and the descriptions identify the proposal. */
export function ApprovalActions({
  headingId,
  approveLabel = 'Approve request',
  declineLabel = 'Decline request',
  approveDisabled,
  busy = false,
  editLabel = 'Edit',
  onApprove,
  onDecline,
  onRequestChanges,
  onEdit,
  onUndo,
}: {
  readonly headingId: string;
  readonly approveLabel?: string | undefined;
  readonly declineLabel?: string;
  readonly approveDisabled: boolean;
  /** Something else is already running: every action waits. */
  readonly busy?: boolean;
  /** "Edit" the first time, "Edit again" after the owner has changed the request. */
  readonly editLabel?: 'Edit' | 'Edit again';
  readonly onApprove: () => void;
  readonly onDecline: () => void;
  readonly onRequestChanges?: ((feedback: string) => void) | undefined;
  /** Absent when this request cannot be edited, or is being edited now. */
  readonly onEdit?: (() => void) | undefined;
  /** Present once the owner has edited the request. */
  readonly onUndo?: (() => void) | undefined;
}): ReactElement {
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [feedback, setFeedback] = useState('');
  const changeButton = useRef<HTMLButtonElement>(null);
  const feedbackField = useRef<HTMLTextAreaElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (requestingChanges) feedbackField.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      changeButton.current?.focus();
    }
  }, [requestingChanges]);

  if (requestingChanges && onRequestChanges) {
    return (
      <form
        aria-labelledby={headingId}
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && feedback.trim()) onRequestChanges(feedback.trim());
        }}
      >
        <Field label="What should change?" hint="This proposal will be declined." required>
          {(field) => (
            <Textarea
              {...field}
              ref={feedbackField}
              rows={3}
              maxLength={2000}
              value={feedback}
              disabled={busy}
              onChange={(event) => {
                setFeedback(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" type="submit" disabled={busy || !feedback.trim()}>
            Send feedback
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              setFeedback('');
              restoreFocus.current = true;
              setRequestingChanges(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        aria-describedby={headingId}
        disabled={approveDisabled || busy}
        onClick={onApprove}
      >
        {approveLabel}
      </Button>
      {onRequestChanges ? (
        <Button
          ref={changeButton}
          variant="ghost"
          aria-describedby={headingId}
          disabled={busy}
          onClick={() => {
            setRequestingChanges(true);
          }}
        >
          Ask for changes
        </Button>
      ) : null}
      {onEdit ? (
        <Button
          variant="ghost"
          aria-describedby={headingId}
          {...(editLabel === 'Edit' ? { 'aria-label': 'Edit before approving' } : {})}
          disabled={busy}
          onClick={onEdit}
        >
          {editLabel}
        </Button>
      ) : null}
      <Button variant="ghost" aria-describedby={headingId} disabled={busy} onClick={onDecline}>
        {declineLabel}
      </Button>
      {onUndo ? (
        <Button variant="ghost" aria-describedby={headingId} disabled={busy} onClick={onUndo}>
          Undo my edits
        </Button>
      ) : null}
    </div>
  );
}

/** An inline link that is still a 44px target on a touch screen. */
export const touchLink =
  'any-pointer-coarse:inline-flex any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:items-center';
