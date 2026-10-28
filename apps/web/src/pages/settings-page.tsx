import { Icon, Nav, Text } from '@nix/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, type ReactElement } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { z } from 'zod';

import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { AccessTokensSection } from '../settings/access-tokens/access-tokens-section';
import { AdministratorsSection } from '../settings/administrators/administrators-section';
import { SiteApprovalsSection } from '../settings/site-approvals/site-approvals-section';
import { BackupsSection } from '../settings/backups/backups-section';
import { ApiSection } from '../settings/api/api-section';
import { McpSection } from '../settings/mcp/mcp-section';
import { CalendarsSection } from '../settings/calendars/calendars-section';
import { DailyNotesSection } from '../settings/daily-notes/daily-notes-section';
import { DailyNotesSwitch } from '../settings/daily-notes/daily-notes-switch';
import { EditorPreferencesSection } from '../settings/editor/editor-preferences-section';
import { PreferencesSection } from '../settings/preferences/PreferencesSection';
import { NotificationsSection } from '../settings/notifications/notifications-section';
import { WorkspaceManagementSection } from '../workspaces/workspace-management-section';
import { PetSettingsSection } from '../pets/pet-settings-section';
import { useCapabilities, type Capabilities } from '../session/capabilities-context';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TAB_PARAM,
  useSettingsTab,
  type SettingsTab,
} from './settings-tab';

const fromState = z.object({ from: z.string() });
const drilledState = z.object({ drilled: z.literal(true) });

type Gate = (capabilities: Capabilities) => boolean;

type Group = 'You' | 'Workspace' | 'Administration';

const GROUPS: readonly { name: Group; label: string }[] = [
  { name: 'You', label: 'Your settings' },
  { name: 'Workspace', label: 'Workspace settings' },
  { name: 'Administration', label: 'Administration settings' },
];

// What is yours, then the workspace's, then the operator's: each section keeps its id so every
// `?tab=` link still lands where it did. The retired `publishing` id resolves to General.
const settingsSections: readonly { id: SettingsTab; label: string; group: Group; gate?: Gate }[] = [
  // Its one setting is publishing, so without sites there is nothing to show.
  { id: 'preferences', label: 'General', group: 'You', gate: (c) => c.sites },
  { id: 'editor', label: 'Editor', group: 'You' },
  { id: 'daily-notes', label: 'Daily notes', group: 'You' },
  { id: 'notifications', label: 'Notifications', group: 'You' },
  { id: 'integrations', label: 'Calendars', group: 'You' },
  { id: 'pets', label: 'Pets', group: 'You' },
  { id: 'workspace', label: 'Workspace', group: 'Workspace' },
  { id: 'access-tokens', label: 'Access tokens', group: 'Workspace' },
  { id: 'mcp', label: 'MCP', group: 'Workspace' },
  { id: 'api', label: 'API', group: 'Workspace' },
  {
    id: 'site-approvals',
    label: 'Site approvals',
    group: 'Administration',
    gate: (c) => c.siteApprover,
  },
  {
    id: 'administrators',
    label: 'Administrators',
    group: 'Administration',
    gate: (c) => c.tenantAdministrator || c.siteApprover,
  },
  { id: 'backups', label: 'Backups', group: 'Administration', gate: (c) => c.operator },
];

function SectionBody(props: { readonly id: SettingsTab }): ReactElement | null {
  switch (props.id) {
    case 'workspace':
      return <WorkspaceManagementSection dailyNotesSwitch={<DailyNotesSwitch />} />;
    case 'editor':
      return <EditorPreferencesSection />;
    case 'preferences':
      return <PreferencesSection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'daily-notes':
      return <DailyNotesSection />;
    case 'pets':
      return <PetSettingsSection />;
    case 'integrations':
      return <CalendarsSection />;
    case 'access-tokens':
      return <AccessTokensSection />;
    case 'mcp':
      return <McpSection />;
    case 'api':
      return <ApiSection />;
    case 'backups':
      return <BackupsSection />;
    case 'site-approvals':
      return <SiteApprovalsSection />;
    case 'administrators':
      return <AdministratorsSection />;
  }
}

/**
 * Settings grouped by the thing being managed, with workspace management first. Addressable by
 * `?tab=` so a link to a specific section survives a refresh or gets shared. Wide: a rail beside
 * the section. Phone: the list of sections, and a pushed page per section so system back returns.
 */
export function SettingsPage(): ReactElement {
  const { requested } = useSettingsTab();
  const narrow = useNarrowViewport();
  const { pathname, state } = useLocation() as { pathname: string; state: unknown };
  // Display hints: Core refuses the operator, approver and administrator routes to everyone else.
  const capabilities = useCapabilities();
  const sections = settingsSections.filter((section) => section.gate?.(capabilities) !== false);
  const offered = sections.some((section) => section.id === requested) ? requested : null;
  // Wide always shows a section; the phone shows the list until one is chosen.
  const activeTab = narrow ? offered : (offered ?? DEFAULT_SETTINGS_TAB);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  // Back to the list undoes the push that opened the section; only a deep link has nothing to undo.
  const drilledFromList = drilledState.safeParse(state).success;
  const lastOpened = useRef<string | undefined>(undefined);
  const cameFrom = fromState.safeParse(state).data?.from;

  // Phone: drilling in puts focus on the section; coming back puts it on the row that was opened.
  useEffect(() => {
    if (!narrow) return;
    if (activeTab !== null) {
      if (scroller.current !== null) scroller.current.scrollTop = 0;
      content.current?.focus({ preventScroll: true });
      lastOpened.current = activeTab;
    } else {
      const row = cameFrom ?? lastOpened.current;
      if (row !== undefined) {
        nav.current?.querySelector<HTMLElement>(`a[href$="${SETTINGS_TAB_PARAM}=${row}"]`)?.focus();
      }
    }
  }, [narrow, activeTab, cameFrom]);

  const hrefFor = (id: SettingsTab): string => `${pathname}?${SETTINGS_TAB_PARAM}=${id}`;
  const navigation = (
    <div
      ref={nav}
      className={`flex flex-col gap-4 ${narrow ? 'p-3' : 'sticky top-0 w-48 shrink-0 self-start'}`}
    >
      {GROUPS.map((group) => {
        const items = sections.filter((section) => section.group === group.name);
        return items.length === 0 ? null : (
          <div key={group.name} className="flex flex-col gap-1">
            <Text as="span" variant="caption" tone="muted" aria-hidden="true">
              {group.name}
            </Text>
            <Nav
              label={group.label}
              items={items.map((section) => ({ href: hrefFor(section.id), label: section.label }))}
              {...(activeTab === null ? {} : { currentHref: hrefFor(activeTab) })}
              renderLink={({ href, children, ...rest }) => (
                <Link
                  to={href}
                  replace={!narrow}
                  state={narrow ? { drilled: true } : undefined}
                  {...rest}
                >
                  {children}
                  {narrow ? <Icon icon={ChevronRight} size="sm" className="ml-auto" /> : null}
                </Link>
              )}
            />
          </div>
        );
      })}
    </div>
  );

  return (
    <div ref={scroller} className={`${paneScroller} flex flex-col`}>
      <header className="border-b border-divider px-3 py-3 sm:px-6 sm:py-4">
        <Text variant="h2" as="h1" className={narrow && activeTab !== null ? 'sr-only' : ''}>
          Settings
        </Text>
      </header>

      {narrow && activeTab !== null ? (
        <Link
          to={pathname}
          replace={!drilledFromList}
          state={{ from: activeTab }}
          onClick={(event) => {
            if (!drilledFromList) return;
            event.preventDefault();
            void navigate(-1);
          }}
          className="flex min-h-11 items-center gap-1 px-3 text-accent-text"
        >
          <Icon icon={ChevronLeft} size="sm" />
          <Text as="span" variant="bodySmall">
            Settings
          </Text>
        </Link>
      ) : null}

      <div className={narrow ? 'min-w-0' : 'flex min-w-0 gap-6 p-6'}>
        {narrow && activeTab !== null ? null : navigation}
        {activeTab === null ? null : (
          <div
            ref={content}
            tabIndex={-1}
            className="min-w-0 max-w-2xl flex-1 break-words p-3 outline-none sm:p-0"
          >
            <SectionBody id={activeTab} />
          </div>
        )}
      </div>
    </div>
  );
}
