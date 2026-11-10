import { Button, Field, Icon, Input, Text } from '@nix/ui';
import { Lock } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';

/** Why an open workspace closed, so the screen that replaces it can say so. */
export type WorkspaceClosedReason = 'relocked' | 'expired';

export interface WorkspaceUnlockScreenProps {
  /** The workspace's name: the one thing a closed workspace shows. */
  readonly name: string;

  /** Why a workspace that was open here closed, or null on a first visit. */
  readonly reason?: WorkspaceClosedReason | null | undefined;

  /** Checks the password. Resolves to a refusal message, or null when the workspace opened. */
  readonly onUnlock: (password: string) => Promise<string | null>;

  /** Leaves for another workspace, when there is one to go to. */
  readonly onLeave?: (() => void) | undefined;
}

/**
 * What stands where a password-protected workspace would be.
 *
 * **Nothing else of the workspace is drawn or requested.** Items, titles, search, members and
 * settings are all behind the password; the shell never mounts, so no content request is left to
 * fail. The name is the only fact shown, because it is the only one Core gives a closed workspace.
 *
 * **It says what a password is and is not.** It hides the workspace from people and sessions
 * without it; it is not encryption.
 *
 * When it replaces a workspace that was open, it says why and takes focus. On a first visit it
 * leaves focus alone: arriving somewhere is not a reason to pull the caret into a form. A wrong
 * password, a throttle and a busy server are announced through the field's error, and focus goes
 * back to the field for another try.
 */
export function WorkspaceUnlockScreen({
  name,
  reason = null,
  onUnlock,
  onLeave,
}: WorkspaceUnlockScreenProps): ReactNode {
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (reason !== null) inputRef.current?.focus();
  }, [reason]);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (password.length === 0) {
      setError('Enter the password.');
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    const refused = await onUnlock(password);
    setBusy(false);
    // Cleared either way: on a refusal the field is ready for another try, and on success this
    // screen is about to be replaced.
    setPassword('');
    if (refused !== null) {
      setError(refused);
      inputRef.current?.focus();
    }
  }

  return (
    <main
      aria-labelledby={headingId}
      className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-4 p-6"
    >
      <div className="flex items-center gap-2">
        <Icon icon={Lock} size="sm" className="text-muted" />
        <Text as="h1" variant="h4" id={headingId}>
          {name.length > 0 ? name : 'This workspace'} is locked
        </Text>
      </div>
      {reason === null ? null : (
        <Text variant="note" role="status">
          {reason === 'expired'
            ? 'This workspace locked again after 15 minutes. Enter the password to keep working.'
            : 'You locked this workspace again.'}
        </Text>
      )}
      <Text variant="note" tone="muted">
        Enter the workspace password to open it in this browser for 15 minutes. The password hides
        the workspace; it is not encryption.
      </Text>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field label="Workspace password" error={error}>
          {(control) => (
            <Input
              {...control}
              ref={inputRef}
              type="password"
              autoComplete="current-password"
              readOnly={busy}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
          {onLeave === undefined ? null : (
            <Button type="button" variant="secondary" onClick={onLeave}>
              Switch workspace
            </Button>
          )}
        </div>
      </form>
    </main>
  );
}
