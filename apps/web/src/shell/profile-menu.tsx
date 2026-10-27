import { Icon, Menu, Text, focusRing, type MenuEntry } from '@nix/ui';
import { ChevronDown, Download, KeyRound, LogOut, Settings, User } from 'lucide-react';
import { type ReactNode } from 'react';
import { Link } from 'react-router';

import { useAuth } from '../auth/auth-provider';
import { useInstallNix } from '../pwa/install-nix';
import { ThemeChoice } from '../theme/theme-choice';
import type { CurrentPrincipalState } from '../session/use-current-principal';
import { useWorkspace } from '../workspaces/workspace-context';
import { usePendingSignOut } from './use-pending-sign-out';

/**
 * The profile menu, top right: who you are, and the things that belong to you rather than to the
 * document you are looking at.
 *
 * Built on `<Menu>` - the account header and the appearance switcher travel in as a `content`
 * entry, exactly as they were laid out before, since neither is a command the arrow keys should
 * walk past. Settings and Sign out are the menu's actual items, which is also what fixed this
 * menu's phone behaviour for free: the panel used to be a literal `w-[240px]` box that ran off a
 * narrow screen, and the trigger below was never given the coarse-pointer touch target every
 * other control in the library gets. Both are `<Menu>`'s problem to solve once now, not this
 * component's to solve again.
 */

export interface ProfileMenuProps {
  readonly principal: CurrentPrincipalState;
}

export function ProfileMenu({ principal }: ProfileMenuProps): ReactNode {
  const { accountUrl } = useAuth();
  const pendingSignOut = usePendingSignOut();
  const { workspaceId } = useWorkspace();
  const install = useInstallNix();

  const name = principal.principal?.displayName ?? 'Loading…';

  const items: MenuEntry[] = [
    {
      kind: 'content',
      content: (
        <div className="border-b border-divider px-3 py-2">
          <Text variant="bodySmall" className="truncate">
            {name}
          </Text>
          {/* Absent rather than blank: a machine identity has no address, and an empty line
              where one should be reads as a bug. */}
          {principal.principal?.email === null ||
          principal.principal?.email === undefined ? null : (
            <Text variant="caption" as="p" tone="muted" className="truncate">
              {principal.principal.email}
            </Text>
          )}
          {principal.status === 'error' ? (
            <Text variant="caption" as="p" tone="muted" role="alert" className="mt-1">
              {principal.error}
            </Text>
          ) : null}
        </div>
      ),
    },
    { kind: 'content', content: <ThemeChoice /> },
    // Kept here as well as on the nav rail. The rail makes workspace administration findable from
    // anywhere; this path keeps personal access tokens beside the identity they belong to.
    { kind: 'link', label: 'Settings', icon: Settings, href: `/w/${workspaceId}/settings` },
    // Password, passkeys and second factors belong to the identity provider, not to Nix, so this
    // leaves for the provider's own page - in a new tab, so unsaved work here survives the visit.
    // Absent when the deployment names none.
    ...(accountUrl === null
      ? []
      : [
          {
            kind: 'link',
            label: 'Password and security',
            icon: KeyRound,
            href: accountUrl,
            external: true,
          } satisfies MenuEntry,
        ]),
    ...(install.offer
      ? [
          {
            kind: 'action',
            label: 'Install Nix',
            icon: Download,
            onSelect: install.install,
          } satisfies MenuEntry,
        ]
      : []),
    {
      kind: 'action',
      label: 'Sign out',
      icon: LogOut,
      onSelect: () => {
        void pendingSignOut.requestSignOut();
      },
    },
  ];

  return (
    <>
      <Menu
        label="Account"
        items={items}
        renderLink={({ href, children, ...rest }) => (
          <Link to={href} {...rest}>
            {children}
          </Link>
        )}
      >
        {(trigger) => (
          <button
            {...trigger}
            className={[
              'flex items-center gap-1.5 border border-transparent px-2 py-1',
              'text-xs text-muted pointer-coarse:min-h-(--control-lg) pointer-coarse:min-w-(--control-lg)',
              `hover:bg-foreground/7 ${focusRing}`,
            ].join(' ')}
          >
            <Icon icon={User} size="sm" />
            <span className="max-w-[16ch] truncate max-lg:sr-only">{name}</span>
            <Icon icon={ChevronDown} size="sm" className="max-lg:hidden" />
          </button>
        )}
      </Menu>
      {pendingSignOut.error ? (
        <Text as="p" variant="note" role="alert">
          {pendingSignOut.error}
        </Text>
      ) : null}
      {pendingSignOut.dialog}
      {install.dialog}
    </>
  );
}
