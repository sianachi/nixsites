import { isCanceledError, workspaceLocks } from '@nix/api-client';
import { Button, Field, Icon, Input, Text } from '@nix/ui';
import { KeyRound } from 'lucide-react';
import { useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { workspaceLockRefusal } from './workspace-lock-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The page a workspace's join link opens: a password field, and nothing about the workspace.
 *
 * **It shows no workspace details before the join succeeds.** Not its name, not whether it exists:
 * Core answers every failure for somebody who is not yet a member - no such workspace, no password,
 * closed to new members, wrong password - with the one refusal, and this page says only that. The
 * person arrives knowing the link and the password, and that is all they are asked for.
 *
 * It sits behind the session gate, so somebody who is signed out meets the sign-in screen at this
 * address and lands back here after it. On success it goes straight into the workspace; the
 * password has already unlocked it for this browser.
 */
export function JoinWorkspacePage(): ReactNode {
  const { workspaceId = '' } = useParams();
  const client = useApiClient();
  const navigate = useNavigate();
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (password.length === 0) {
      setError('Enter the password.');
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    let joined = false;
    try {
      // A link that is not even an identifier gets the answer any wrong link gets, without a call.
      if (!UUID.test(workspaceId)) {
        setError(
          'That link and password did not open a workspace. Check both with whoever shared it.',
        );
      } else {
        await client.execute(workspaceLocks.joinWorkspace(workspaceId, password));
        joined = true;
      }
    } catch (cause) {
      if (!isCanceledError(cause)) {
        setError(workspaceLockRefusal(cause, 'You could not be added. Try again.'));
      }
    }
    setBusy(false);
    setPassword('');
    if (joined) {
      void navigate(`/w/${workspaceId}`, { replace: true });
    } else {
      inputRef.current?.focus();
    }
  }

  return (
    <main
      aria-labelledby={headingId}
      className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-4 p-6"
    >
      <div className="flex items-center gap-2">
        <Icon icon={KeyRound} size="sm" className="text-muted" />
        <Text as="h1" variant="h4" id={headingId}>
          Join a workspace
        </Text>
      </div>
      <Text variant="note" tone="muted">
        Enter the password you were given with the link. You join as a viewer, and the workspace
        opens in this browser for 15 minutes at a time.
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
              autoComplete="off"
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
            {busy ? 'Joining…' : 'Join'}
          </Button>
          <Link to="/">
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </Link>
        </div>
      </form>
    </main>
  );
}
