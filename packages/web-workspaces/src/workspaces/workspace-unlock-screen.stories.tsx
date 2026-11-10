import type { ReactElement } from 'react';

import { WorkspaceUnlockScreen } from './workspace-unlock-screen';

export default { title: 'Nix/Workspace password', parameters: { layout: 'fullscreen' } };

const refuseWrongPassword = (password: string): Promise<string | null> =>
  Promise.resolve(password === 'hunter22' ? null : 'That password is not right.');

/** What stands where a password-protected workspace would be: its name and the way in. */
export function Locked(): ReactElement {
  return <WorkspaceUnlockScreen name="Family archive" onUnlock={refuseWrongPassword} />;
}

/** The screen after the fifteen minutes ran out while somebody was working. */
export function LockedAgainAfterExpiry(): ReactElement {
  return (
    <WorkspaceUnlockScreen
      name="Family archive"
      reason="expired"
      onUnlock={refuseWrongPassword}
      onLeave={() => undefined}
    />
  );
}

/** After somebody chose to lock the workspace again. */
export function LockedAgainByChoice(): ReactElement {
  return (
    <WorkspaceUnlockScreen
      name="Family archive"
      reason="relocked"
      onUnlock={refuseWrongPassword}
      onLeave={() => undefined}
    />
  );
}

/** A throttled password is the reason shown, not a wrong one. */
export function Throttled(): ReactElement {
  return (
    <WorkspaceUnlockScreen
      name="Family archive"
      onUnlock={() => Promise.resolve('Too many wrong passwords. Try again in 2 minute(s).')}
    />
  );
}
