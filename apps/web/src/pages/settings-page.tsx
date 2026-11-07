import { Icon, Input, Nav, Text } from '@nix/ui';
import {
  Bell,
  Building2,
  Calendar,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Code,
  HardDrive,
  Info,
  KeyRound,
  PawPrint,
  PenLine,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { z } from 'zod';

import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { AccessTokensSection } from '@nix/web-settings/settings/access-tokens/access-tokens-section';
import { AdministratorsSection } from '@nix/web-settings/settings/administrators/administrators-section';
import { SiteApprovalsSection } from '@nix/web-settings/settings/site-approvals/site-approvals-section';
import { BackupsSection } from '@nix/web-settings/settings/backups/backups-section';
import { AboutSection } from '@nix/web-settings/settings/about/about-section';
import { ApiSection } from '@nix/web-settings/settings/api/api-section';
import { McpSection } from '@nix/web-settings/settings/mcp/mcp-section';
import { CalendarsSection } from '@nix/web-settings/settings/calendars/calendars-section';
import { DailyNotesSection } from '@nix/web-settings/settings/daily-notes/daily-notes-section';
import { DailyNotesSwitch } from '@nix/web-settings/settings/daily-notes/daily-notes-switch';
import { EditorPreferencesSection } from '@nix/web-settings/settings/editor/editor-preferences-section';
import { PreferencesSection } from '@nix/web-settings/settings/preferences/PreferencesSection';
import { NotificationsSection } from '@nix/web-settings/settings/notifications/notifications-section';
import { WorkspaceManagementSection } from '@nix/web-workspaces/workspaces/workspace-management-section';
import { PetSettingsSection } from '@nix/web-pets/pets/pet-settings-section';
import { useCapabilities, type Capabilities } from '@nix/web-platform/session/capabilities-context';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TAB_PARAM,
  useSettingsTab,
  type SettingsTab,
} from './settings-tab';
import { useInRouteDialog } from '@nix/web-foundation/layout/route-dialog-context';

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
  { id: 'preferences', label: 'General', group: 'You' },
  { id: 'editor', label: 'Editor', group: 'You' },
  { id: 'daily-notes', label: 'Daily notes', group: 'You' },
  { id: 'notifications', label: 'Notifications', group: 'You' },
  { id: 'integrations', label: 'Calendars', group: 'You' },
  { id: 'pets', label: 'Pets', group: 'You' },
  { id: 'about', label: 'About', group: 'You' },
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

// Phone rows carry an icon, as the grouped settings list does.
const sectionIcons: Record<SettingsTab, LucideIcon> = {
  preferences: SlidersHorizontal,
  editor: PenLine,
  'daily-notes': CalendarDays,
  notifications: Bell,
  integrations: Calendar,
  pets: PawPrint,
  about: Info,
  workspace: Building2,
  'access-tokens': KeyRound,
  mcp: Plug,
  api: Code,
  'site-approvals': ShieldCheck,
  administrators: Users,
  backups: HardDrive,
};

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
    case 'about':
      return <AboutSection />;
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
  const inDialog = useInRouteDialog();
  const { pathname, state } = useLocation() as { pathname: string; state: unknown };
  // Display hints: Core refuses the operator, approver and administrator routes to everyone else.
  const capabilities = useCapabilities();
  const sections = settingsSections.filter((section) => section.gate?.(capabilities) !== false);
  const offered = sections.some((section) => section.id === requested) ? requested : null;
  // Wide always shows a section; the phone shows the list until one is chosen.
  const activeTab = narrow ? offered : (offered ?? DEFAULT_SETTINGS_TAB);

  const [query, setQuery] = useState('');
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
      className={`flex flex-col gap-4 ${narrow ? 'px-3 pb-6' : 'sticky top-0 w-48 shrink-0 self-start'}`}
    >
      {GROUPS.map((group) => {
        const items = sections.filter(
          (section) =>
            section.group === group.name &&
            (!narrow || section.label.toLowerCase().includes(query.trim().toLowerCase())),
        );
        return items.length === 0 ? null : (
          <div key={group.name} className="flex flex-col gap-1">
            <Text
              as="span"
              variant="caption"
              tone="muted"
              aria-hidden="true"
              className={narrow ? 'px-3' : ''}
            >
              {group.name}
            </Text>
            <div
              className={
                narrow
                  ? 'overflow-hidden rounded-card [&_a]:flex [&_a]:min-h-11 [&_a]:items-center [&_a]:gap-3 [&_a]:bg-surface-raised [&_a]:px-3'
                  : ''
              }
            >
              <Nav
                label={group.label}
                items={items.map((section) => ({
                  href: hrefFor(section.id),
                  label: section.label,
                }))}
                {...(activeTab === null ? {} : { currentHref: hrefFor(activeTab) })}
                renderLink={({ href, children, ...rest }) => (
                  <Link
                    to={href}
                    replace={!narrow}
                    state={narrow ? { drilled: true } : undefined}
                    {...rest}
                  >
                    {narrow ? (
                      <Icon
                        icon={
                          sectionIcons[items.find((s) => hrefFor(s.id) === href)?.id ?? 'about']
                        }
                        size="sm"
                        className="text-muted"
                      />
                    ) : null}
                    {children}
                    {narrow ? <Icon icon={ChevronRight} size="sm" className="ml-auto" /> : null}
                  </Link>
                )}
              />
            </div>
          </div>
        );
      })}
      {narrow &&
      !sections.some((section) =>
        section.label.toLowerCase().includes(query.trim().toLowerCase()),
      ) ? (
        <Text as="p" tone="muted" role="status" className="px-3">
          No settings match “{query.trim()}”.
        </Text>
      ) : null}
    </div>
  );

  return (
    <div ref={scroller} className={`${paneScroller} flex flex-col ${narrow ? 'bg-surface' : ''}`}>
      {inDialog ? null : (
        <header
          className={`px-3 py-3 sm:px-6 sm:py-4 ${narrow ? 'relative flex items-center justify-center' : 'border-b border-divider'}`}
        >
          <Text variant="h2" as="h1" className={narrow && activeTab !== null ? 'sr-only' : ''}>
            Settings
          </Text>
          {narrow ? (
            <Link
              to="/"
              aria-label="Close settings"
              className="absolute right-3 flex size-9 items-center justify-center rounded-full bg-surface-raised"
            >
              <Icon icon={X} size="sm" />
            </Link>
          ) : null}
        </header>
      )}

      {narrow && activeTab === null ? (
        <div className="px-3 pb-3">
          <Input
            type="search"
            aria-label="Search settings"
            placeholder="Search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            className="w-full rounded-card bg-surface-raised"
          />
        </div>
      ) : null}

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

      <div className={narrow ? 'min-w-0' : `flex min-w-0 gap-6 ${inDialog ? 'pt-2' : 'p-6'}`}>
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
