import {
  isCanceledError,
  isNixApiError,
  workspaceLocks,
  workspaces as coreWorkspaces,
} from '@nix/api-client';
import { Button, Field, Input, Text } from '@nix/ui';
import { useState, type ReactNode, type SyntheticEvent } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { workspaceJoinUrl, workspaceLockRefusal } from '../workspace-lock-errors';
import { rememberClosedReason } from '../workspace-lock-state';
import { useWorkspace } from '../workspace-context';

type Busy = 'set' | 'change' | 'remove' | 'lock' | null;

/**
 * A workspace's password: closing it behind one, the join link, and locking it again now.
 *
 * **Owners set, change and remove the password.** Changing or removing it needs the current one, so
 * somebody at an unattended session cannot swap it, and a change ends every other session's
 * unlock. There is no way to recover a forgotten password; the section says so before it is set.
 *
 * **Everyone in a protected workspace can lock it again now**, which closes it to this browser at
 * once instead of waiting for the unlock to run out.
 *
 * The password hides the workspace from members who have not entered it. It is not encryption, and
 * the copy says so where somebody decides to rely on it.
 */
export function WorkspacePasswordSection(): ReactNode {
  const client = useApiClient();
  const context = useWorkspace();
  const { workspace } = context;
  const canManage = workspace.canManageMembers;
  const protectedNow = workspace.passwordProtected === true;

  const [busy, setBusy] = useState<Busy>(null);
  const [newPassword, setNewPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [removePassword, setRemovePassword] = useState('');
  const [errors, setErrors] = useState<
    Partial<Record<'new' | 'current' | 'remove' | 'lock', string>>
  >({});

  if (!canManage && !protectedNow) return null;

  async function reread(): Promise<void> {
    try {
      context.workspaceUpdated(
        await client.query(coreWorkspaces.workspaceById(workspace.id), { forceRefresh: true }),
      );
    } catch (cause) {
      if (!isCanceledError(cause)) context.reload();
    }
  }

  async function run(
    kind: Exclude<Busy, null>,
    field: 'new' | 'current' | 'remove' | 'lock',
    command: ReturnType<typeof workspaceLocks.setWorkspacePassword>,
    done: string,
    failure: string,
  ): Promise<boolean> {
    setBusy(kind);
    setErrors({});
    try {
      await client.execute(command);
    } catch (cause) {
      if (isCanceledError(cause)) return false;
      // A too-short new password belongs under the new-password field, whichever form sent it.
      const target =
        isNixApiError(cause) && cause.code === 'workspaces.password_invalid' ? 'new' : field;
      setErrors({ [target]: workspaceLockRefusal(cause, failure) });
      return false;
    } finally {
      setBusy(null);
    }
    await reread();
    publishNotice({ key: 'workspace-password', message: done });
    return true;
  }

  async function submitSet(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy !== null) return;
    if (newPassword.length < 8) {
      setErrors({ new: 'Use a password of at least 8 characters.' });
      return;
    }
    const saved = await run(
      protectedNow ? 'change' : 'set',
      protectedNow ? 'current' : 'new',
      workspaceLocks.setWorkspacePassword(
        workspace.id,
        newPassword,
        protectedNow ? currentPassword : undefined,
      ),
      protectedNow ? 'Workspace password changed.' : 'Workspace password set.',
      'The password could not be saved. Try again.',
    );
    if (saved) {
      setNewPassword('');
      setCurrentPassword('');
    }
  }

  async function submitRemove(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy !== null) return;
    if (removePassword.length === 0) {
      setErrors({ remove: 'Enter the current password.' });
      return;
    }
    if (
      await run(
        'remove',
        'remove',
        workspaceLocks.removeWorkspacePassword(workspace.id, removePassword),
        'Workspace password removed.',
        'The password could not be removed. Try again.',
      )
    ) {
      setRemovePassword('');
    }
  }

  async function lockNow(): Promise<void> {
    if (busy !== null) return;
    setBusy('lock');
    setErrors({});
    try {
      await client.execute(workspaceLocks.relockWorkspace(workspace.id));
    } catch (cause) {
      if (!isCanceledError(cause)) {
        setErrors({
          lock: workspaceLockRefusal(cause, 'The workspace could not be locked. Try again.'),
        });
      }
      setBusy(null);
      return;
    }
    // Said before the list changes, so the screen that replaces the workspace can say why.
    rememberClosedReason(workspace.id, 'relocked');
    await reread();
    setBusy(null);
  }

  function copyLink(): void {
    const link = workspaceJoinUrl(workspace.id);
    if (!('clipboard' in navigator)) {
      publishNotice({
        key: 'workspace-password',
        message: 'Could not copy. Select the link and copy it by hand.',
      });
      return;
    }
    navigator.clipboard.writeText(link).then(
      () => {
        publishNotice({ key: 'workspace-password', message: 'Join link copied.' });
      },
      () => {
        publishNotice({
          key: 'workspace-password',
          message: 'Could not copy. Select the link and copy it by hand.',
        });
      },
    );
  }

  return (
    <section aria-labelledby="workspace-password-heading" className="flex flex-col gap-3">
      <Text id="workspace-password-heading" variant="h4" as="h3">
        Password
      </Text>

      {protectedNow ? (
        <div className="flex flex-col gap-2">
          <Text variant="note" tone="muted">
            Members must enter the password to open this workspace. It is unlocked in this browser
            for 15 minutes at a time.
          </Text>
          <div>
            <Button
              type="button"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                void lockNow();
              }}
            >
              {busy === 'lock' ? 'Locking…' : 'Lock now'}
            </Button>
          </div>
          {errors.lock === undefined ? null : (
            <Text role="alert" variant="note">
              {errors.lock}
            </Text>
          )}
        </div>
      ) : null}

      {canManage ? (
        <>
          <Text variant="note" tone="muted">
            {protectedNow
              ? 'Changing the password closes the workspace in every other session. '
              : 'A password closes this workspace to everyone, members included, until they enter it, and lets anyone in your organization who has the join link and the password join as a viewer. '}
            The password hides the workspace; it is not encryption. If it is forgotten it cannot be
            recovered.
          </Text>
          <form
            noValidate
            aria-label={protectedNow ? 'Change password' : 'Set password'}
            className="flex max-w-sm flex-col gap-3"
            onSubmit={(event) => {
              void submitSet(event);
            }}
          >
            {protectedNow ? (
              <Field label="Current password" error={errors.current ?? null}>
                {(control) => (
                  <Input
                    {...control}
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => {
                      setCurrentPassword(event.target.value);
                    }}
                  />
                )}
              </Field>
            ) : null}
            <Field label="New password" hint="At least 8 characters." error={errors.new ?? null}>
              {(control) => (
                <Input
                  {...control}
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => {
                    setNewPassword(event.target.value);
                  }}
                />
              )}
            </Field>
            <div>
              <Button type="submit" disabled={busy !== null}>
                {protectedNow
                  ? busy === 'change'
                    ? 'Changing…'
                    : 'Change password'
                  : busy === 'set'
                    ? 'Setting…'
                    : 'Set password'}
              </Button>
            </div>
          </form>

          {protectedNow ? (
            <>
              <div className="flex max-w-xl flex-col gap-1">
                <Text variant="bodySmall">Join link</Text>
                <Text variant="note" tone="muted">
                  Share the link and the password. Anyone in your organization who signs in and
                  enters the password joins as a viewer.
                </Text>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    aria-label="Join link"
                    value={workspaceJoinUrl(workspace.id)}
                    onFocus={(event) => {
                      event.currentTarget.select();
                    }}
                  />
                  <Button type="button" variant="secondary" onClick={copyLink}>
                    Copy
                  </Button>
                </div>
              </div>

              <form
                noValidate
                aria-label="Remove password"
                className="flex max-w-sm flex-col gap-3"
                onSubmit={(event) => {
                  void submitRemove(event);
                }}
              >
                <Field label="Current password" error={errors.remove ?? null}>
                  {(control) => (
                    <Input
                      {...control}
                      type="password"
                      autoComplete="current-password"
                      value={removePassword}
                      onChange={(event) => {
                        setRemovePassword(event.target.value);
                      }}
                    />
                  )}
                </Field>
                <div>
                  <Button type="submit" variant="secondary" disabled={busy !== null}>
                    {busy === 'remove' ? 'Removing…' : 'Remove password'}
                  </Button>
                </div>
              </form>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
