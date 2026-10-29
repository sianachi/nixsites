import { Button, Text } from '@nix/ui';
import { useId, type ReactElement, type ReactNode } from 'react';

/**
 * The one frame a write wears while it waits for the owner, for the pet's cards and for a
 * generated component's alike: a hairline group named by the operation and its target, so two
 * waiting cards never share a heading, and the three actions on one row beneath. It is flat
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

/** Approve request, Edit and Decline request, in that order, on one row. Each is described by the
 * frame's heading, so the name of a button says what it does and the description says to what. */
export function ApprovalActions({
  headingId,
  approveDisabled,
  busy = false,
  editLabel,
  onApprove,
  onDecline,
  onEdit,
  onUndo,
}: {
  readonly headingId: string;
  readonly approveDisabled: boolean;
  /** Something else is already running: every action waits. */
  readonly busy?: boolean;
  /** "Edit" the first time, "Edit again" after the owner has changed the request. */
  readonly editLabel: 'Edit' | 'Edit again';
  readonly onApprove: () => void;
  readonly onDecline: () => void;
  /** Absent when this request cannot be edited, or is being edited now. */
  readonly onEdit: (() => void) | undefined;
  /** Present once the owner has edited the request. */
  readonly onUndo: (() => void) | undefined;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        aria-describedby={headingId}
        disabled={approveDisabled || busy}
        onClick={onApprove}
      >
        Approve request
      </Button>
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
        Decline request
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
