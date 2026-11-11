import { Icon, Menu, Text, focusRing, type MenuEntry } from '@nix/ui';
import {
  ChevronDown,
  Download,
  KeyRound,
  LogOut,
  Server,
  Settings,
  SlidersHorizontal,
  User,
} from 'lucide-react';
import { type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';

import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { inNativeShell, switchServer, useInstallNix } from '@nix/web-platform/pwa/install-nix';
import { ThemeChoice } from '@nix/web-foundation/theme/theme-choice';
import type { CurrentPrincipalState } from '@nix/web-platform/session/use-current-principal';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useWorkspaceMenuEntries } from '@nix/web-workspaces/workspaces/workspace-switcher';
import { ZenLayoutPreview, type ZenLayoutPreferences } from './zen-layout-preview';
import { usePendingSignOut } from './use-pending-sign-out';
import { useHiddenItemsEntry } from '../items/hidden-items-panel';

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

  /** An icon-only trigger, for the rail: the name stays as the accessible label. */
  readonly compactTrigger?: boolean;
  readonly layoutPreferences?: ZenLayoutPreferences | undefined;
  readonly showWorkspaceMenu?: boolean;
}

export function ProfileMenu({
  principal,
  compactTrigger = false,
  layoutPreferences,
  showWorkspaceMenu = true,
}: ProfileMenuProps): ReactNode {
  const { accountUrl } = useAuth();
  const pendingSignOut = usePendingSignOut();
  const { workspaceId } = useWorkspace();
  const install = useInstallNix();
  const workspaceMenu = useWorkspaceMenuEntries();
  const hiddenItems = useHiddenItemsEntry();

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
    { kind: 'separator' },
    ...(showWorkspaceMenu ? workspaceMenu.entries : []),
    ...(hiddenItems.entry === null ? [] : [hiddenItems.entry]),
    { kind: 'separator' },
    { kind: 'content', content: <ThemeChoice /> },
    ...(layoutPreferences === undefined
      ? []
      : [
          {
            kind: 'action',
            label: 'Preferences',
            icon: SlidersHorizontal,
            onSelect: () => {
              if (layoutPreferences.preview.draft === null) layoutPreferences.preview.open();
            },
          } satisfies MenuEntry,
        ]),
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
    ...(inNativeShell
      ? [
          {
            kind: 'action',
            label: 'Switch server',
            icon: Server,
            onSelect: switchServer,
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

  const accountMenu = (anchor?: RefObject<HTMLButtonElement | null>): ReactNode => (
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
          onClick={() => {
            if (layoutPreferences?.preview.draft) layoutPreferences.preview.cancel();
            trigger.onClick();
          }}
          ref={(element) => {
            trigger.ref.current = element;
            if (anchor !== undefined) anchor.current = element;
          }}
          title={compactTrigger ? name : undefined}
          className={
            compactTrigger
              ? `flex size-(--rail-control) items-center justify-center rounded-md text-muted any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:min-w-(--control-lg) hover:bg-foreground/7 hover:text-foreground ${focusRing}`
              : [
                  'flex items-center gap-1.5 border border-transparent px-2 py-1',
                  'text-xs text-muted pointer-coarse:min-h-(--control-lg) pointer-coarse:min-w-(--control-lg)',
                  `hover:bg-foreground/7 ${focusRing}`,
                ].join(' ')
          }
        >
          <Icon icon={User} size={compactTrigger ? 'md' : 'sm'} />
          <span className={compactTrigger ? 'sr-only' : 'max-w-[16ch] truncate max-lg:sr-only'}>
            {name}
          </span>
          {compactTrigger ? null : <Icon icon={ChevronDown} size="sm" className="max-lg:hidden" />}
        </button>
      )}
    </Menu>
  );

  return (
    <>
      {layoutPreferences === undefined ? (
        accountMenu()
      ) : (
        <ZenLayoutPreview {...layoutPreferences} anchor={accountMenu} />
      )}
      {pendingSignOut.error ? (
        <Text as="p" variant="note" role="alert">
          {pendingSignOut.error}
        </Text>
      ) : null}
      {pendingSignOut.dialog}
      {install.dialog}
      {workspaceMenu.dialogs}
      {hiddenItems.dialog}
    </>
  );
}
