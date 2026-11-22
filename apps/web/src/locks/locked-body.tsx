import { Button, Field, Icon, Input, Text } from '@nix/ui';
import { Lock } from 'lucide-react';
import { usePasswordPrompt } from '@nix/web-workspaces/workspaces/use-password-prompt';
import { useId, type ReactNode } from 'react';

import type { LockClosedReason } from './use-item-lock';

/**
 * What stands where a locked body, or a locked item's views, would be.
 *
 * **It says whose password opens it.** A lock covers everything under the locked item, so a note
 * inside a locked folder is opened with the folder's password. The prompt names the folder then,
 * rather than asking for a password the note never had.
 *
 * **It says what a lock is and is not.** A lock hides the text from anybody without the password;
 * it is not encryption. Somebody deciding what to put behind one deserves to know that, and the
 * place they meet the lock is where they will read it.
 *
 * **When it replaces a body that was open, it says why and takes focus.** A body that closes under
 * somebody - because their fifteen minutes ran out, or because they locked it again - would
 * otherwise leave focus on nothing and a prompt indistinguishable from a first visit. On a first
 * visit it leaves focus alone: arriving at a note is not a reason to pull the caret into a form.
 *
 * The password field is labelled and the refusal is announced through the field's error, so a
 * wrong password is heard as well as seen, and focus goes back to the field for another try.
 */

export interface LockedBodyProps {
  /** What the item is called, so the prompt names what it opens. */
  readonly title: string;

  /** What kind of thing is locked - "note", "canvas" - for the copy. */
  readonly noun: string;

  /** Why an open body closed here, or null when it was never open in this view. */
  readonly reason?: LockClosedReason | null | undefined;

  /**
   * The title of the ancestor whose lock covers this item, or null when the lock is the item's own.
   * An empty string names an ancestor whose title is not known here.
   */
  readonly holderTitle?: string | null | undefined;

  /** Checks the password. Resolves to a refusal message, or null when the body opened. */
  readonly onUnlock: (password: string) => Promise<string | null>;
}

export function LockedBody({
  title,
  noun,
  reason = null,
  holderTitle = null,
  onUnlock,
}: LockedBodyProps): ReactNode {
  const headingId = useId();
  const { error, busy, input, onSubmit } = usePasswordPrompt(reason, onUnlock);
  const name = title.length > 0 ? title : 'Untitled';

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-1 items-start justify-center overflow-y-auto px-6 py-12"
    >
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex items-center gap-2">
          <Icon icon={Lock} size="sm" className="text-muted" />
          <Text as="h2" variant="h4" id={headingId}>
            {name} is locked
          </Text>
        </div>
        {reason === null ? null : (
          <Text variant="note" role="status">
            {reason === 'expired'
              ? `This ${noun} locked again after 15 minutes. Enter the password to keep reading.`
              : `You locked this ${noun} again.`}
          </Text>
        )}
        <Text variant="note" tone="muted">
          {holderTitle === null
            ? 'Enter the password to open it in this browser for 15 minutes.'
            : holderTitle.length > 0
              ? `It is inside ${holderTitle}, which is locked. Enter the password for ${holderTitle} to open it in this browser for 15 minutes.`
              : 'It is inside a locked item. Enter that item\u2019s password to open it in this browser for 15 minutes.'}{' '}
          The lock hides what is inside; it is not encryption.
        </Text>
        <form noValidate className="flex flex-col gap-3" onSubmit={onSubmit}>
          <Field label="Password" error={error}>
            {(control) => <Input {...control} {...input} />}
          </Field>
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
