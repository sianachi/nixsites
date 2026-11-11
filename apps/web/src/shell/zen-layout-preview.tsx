import {
  uiSettings,
  workspaceLayoutSchema,
  sidebarDestinationSchema,
  type WorkspaceLayout,
  type UiSettingsPatch,
  type SidebarDestination,
  type SidebarOverrides,
} from '@nix/api-client';
import { ThemeFields } from '@nix/web-foundation/theme/theme-choice';
import { useTheme, type ThemeSelection, type Theme } from '@nix/web-foundation/theme/use-theme';
import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { writeStored } from '@nix/web-foundation/lib/stored-setting';
import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { Button, Checkbox, Icon, Popover, Segmented, Select, Text, useUndo } from '@nix/ui';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { sidebarChoices } from './nav-rail';

const settings = {
  explorer: 'Pinned Explorer',
  navigation: 'Navigation rail',
  status: 'Status bar',
  insert: 'Note insert tools',
  advanced: 'Advanced note tools',
  view: 'Collection controls',
} as const;
type Setting = keyof typeof settings;
const settingKeys = [
  'explorer',
  'navigation',
  'status',
  'view',
  'insert',
  'advanced',
] as const satisfies readonly Setting[];

const presets = [
  {
    id: 'essentials',
    label: 'Essentials',
    detail: 'A clear workspace with one view picker and basic writing tools.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    detail: 'Planning and writing tools with a shorter sidebar and no status bar by default.',
  },
  {
    id: 'full',
    label: 'Full toolkit',
    detail: 'Show the full sidebar and status bar, plus Markdown and advanced writing tools.',
  },
] as const;
type Preset = WorkspaceLayout['preset'];

function readLayout(key: string | null): WorkspaceLayout | null {
  if (key === null) return null;
  try {
    const raw = browserStorage()?.getItem(key);
    return raw ? (workspaceLayoutSchema.safeParse(JSON.parse(raw)).data ?? null) : null;
  } catch {
    return null;
  }
}

function defaultVisible(preset: Preset, setting: Setting): boolean {
  return (
    preset === 'full' || (preset === 'workspace' && setting !== 'advanced' && setting !== 'status')
  );
}

function visible(layout: WorkspaceLayout, setting: Setting): boolean {
  return layout.overrides[setting] ?? defaultVisible(layout.preset, setting);
}

function sameLayout(left: WorkspaceLayout | null, right: WorkspaceLayout | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.preset === right.preset &&
      settingKeys.every((setting) => left.overrides[setting] === right.overrides[setting]))
  );
}

function presetLabel(preset: Preset): string {
  return presets.find((entry) => entry.id === preset)?.label ?? preset;
}

const workspaceDestinations = new Set<SidebarDestination>([
  'daily',
  'calendar',
  'bookmarks',
  'queries',
  'pet',
]);

function hiddenByDefault(preset: Preset, id: SidebarDestination): boolean {
  return preset === 'essentials' || (preset === 'workspace' && !workspaceDestinations.has(id));
}

function sameDestinations(left: SidebarOverrides, right: SidebarOverrides): boolean {
  return sidebarDestinationSchema.options.every((id) => left[id] === right[id]);
}

function promptKey(key: string): string {
  return `${key}.preferences-seen`;
}

function hasSeenPrompt(key: string): boolean {
  try {
    return browserStorage()?.getItem(promptKey(key)) === '1';
  } catch {
    return false;
  }
}

type PreferencesPatch = Pick<UiSettingsPatch, 'shell.layout' | 'shell.sidebarHidden'>;

interface Preview {
  readonly active: boolean;
  readonly welcome: boolean;
  readonly theme: ThemeSelection & Pick<Theme, 'ground'>;
  readonly setThemeDraft: (next: ThemeSelection) => void;
  readonly hiddenDestinations: readonly SidebarDestination[];
  readonly toggleDestination: (id: SidebarDestination) => void;
  readonly canResetSidebar: boolean;
  readonly resetSidebar: () => void;
  readonly draft: WorkspaceLayout | null;
  readonly setDraft: (layout: WorkspaceLayout) => void;
  readonly changed: boolean;
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly visible: (setting: Setting) => boolean;
  readonly explorer: boolean;
  readonly toggleExplorer: () => void;
  readonly open: () => void;
  readonly cancel: () => void;
  readonly apply: (close: () => void) => Promise<void>;
}

interface LayoutSession {
  readonly key: string | null;
  readonly applied: WorkspaceLayout | null;
  readonly hidden: SidebarOverrides;
  readonly draftHidden: SidebarOverrides | null;
  readonly welcome: boolean;
  readonly draft: WorkspaceLayout | 'open' | null;
  readonly revision: number;
  readonly explorerPeek: boolean | null;
  readonly saving: boolean;
  readonly saveFailed: boolean;
}

function startSession(key: string | null): LayoutSession {
  return {
    key,
    applied: readLayout(key),
    hidden: {},
    draftHidden: null,
    welcome: false,
    draft: null,
    revision: -1,
    explorerPeek: null,
    saving: false,
    saveFailed: false,
  };
}

export function useZenLayoutPreview(
  subject: string | null,
  native: Pick<Record<Setting, boolean>, 'explorer' | 'navigation' | 'status'>,
): Preview {
  const key = subject === null ? null : `nix.layout.${subject}`;
  const client = useOptionalApiClient();
  const [session, setSession] = useState(() => startSession(key));
  const connection = useRef<{ signal: AbortSignal; pending: boolean } | null>(null);
  const undo = useUndo();
  const [themeDraft, setThemeDraft] = useState<ThemeSelection | null>(null);
  const theme = useTheme(themeDraft);
  const prompted = useRef<string | null>(null);
  let currentSession = session;
  if (session.key !== key) {
    currentSession = startSession(key);
    setSession(currentSession);
    setThemeDraft(null);
  }
  const { applied, hidden, welcome, explorerPeek, saving, saveFailed } = currentSession;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    connection.current = { signal, pending: false };
    const refresh = (): void => {
      if (client === null || key === null) return;
      void client.query(uiSettings.settings(), { signal, forceRefresh: true }).then(
        ({ settings: saved, revision }) => {
          if (signal.aborted) return;
          const layout = saved['shell.layout'] ?? null;
          const seen = saved['shell.preferencesSeen'] === true || hasSeenPrompt(key);
          setSession((value) => {
            if (value.key !== key || value.revision >= revision) return value;
            const firstPrompt =
              value.revision < 0 && value.applied === null && layout === null && !seen;
            return {
              ...value,
              applied: layout,
              hidden: saved['shell.sidebarHidden'] ?? {},
              explorerPeek: sameLayout(value.applied, layout) ? value.explorerPeek : null,
              revision,
              ...(firstPrompt ? { draft: value.draft ?? 'open', welcome: true } : {}),
            };
          });
        },
        () => {
          // Keep the cached layout when Core is unreachable.
        },
      );
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      if (connection.current?.pending === true) {
        setSession((value) => (value.key === key ? { ...value, saving: false } : value));
      }
      controller.abort();
      connection.current = null;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [client, key]);

  useEffect(() => {
    if (key !== null) writeStored(key, applied === null ? null : JSON.stringify(applied));
  }, [key, applied]);

  useEffect(() => {
    if (!welcome || key === null || client === null || prompted.current === key) return;
    prompted.current = key;
    writeStored(promptKey(key), '1');
    const signal = connection.current?.signal;
    void client
      .execute(uiSettings.patchSettings({ 'shell.preferencesSeen': true }), { signal })
      .catch(() => {
        // This browser already remembers the prompt if Core is temporarily unavailable.
      });
  }, [client, key, welcome]);

  // Before the first apply, respect the person's current shell settings.
  const initial: WorkspaceLayout = {
    preset: 'full',
    overrides: {
      ...(native.explorer ? {} : { explorer: false }),
      ...(native.navigation ? {} : { navigation: false }),
      ...(native.status ? {} : { status: false }),
    },
  };
  const baseline = applied ?? initial;
  const draft = currentSession.draft === 'open' ? baseline : currentSession.draft;
  const layoutChanged = draft !== null && !sameLayout(baseline, draft);
  const current = draft ?? baseline;
  const sidebarOverrides = currentSession.draftHidden ?? hidden;
  const hiddenDestinations = sidebarDestinationSchema.options.filter(
    (id) =>
      current.preset === 'essentials' ||
      (sidebarOverrides[id] ?? hiddenByDefault(current.preset, id)),
  );
  const sidebarChanged = !sameDestinations(hidden, sidebarOverrides);
  const themeChanged =
    themeDraft !== null && (themeDraft.mode !== theme.mode || themeDraft.palette !== theme.palette);
  const changed = layoutChanged || sidebarChanged || themeChanged;

  async function save(next: PreferencesPatch, expected?: PreferencesPatch) {
    const scope = connection.current;
    if (scope === null || scope.pending) return null;
    scope.pending = true;
    const update = (updateSession: (value: LayoutSession) => LayoutSession): void => {
      if (!scope.signal.aborted) {
        setSession((value) => (value.key === key ? updateSession(value) : value));
      }
    };
    update((value) => ({ ...value, saving: true, saveFailed: false }));
    try {
      let previousLayout = applied;
      let previousHidden = hidden;
      if (client !== null && key !== null) {
        const options = { signal: scope.signal, forceRefresh: true };
        const before = await client.query(uiSettings.settings(), options);
        previousLayout = before.settings['shell.layout'] ?? null;
        previousHidden = before.settings['shell.sidebarHidden'] ?? {};
        const expectedLayout = expected?.['shell.layout'];
        const expectedHidden = expected?.['shell.sidebarHidden'];
        if (
          (expectedLayout !== undefined && !sameLayout(previousLayout, expectedLayout)) ||
          (expectedHidden !== undefined && !sameDestinations(previousHidden, expectedHidden ?? {}))
        ) {
          update((value) =>
            value.revision > before.revision
              ? value
              : {
                  ...value,
                  applied: previousLayout,
                  hidden: previousHidden,
                  revision: before.revision,
                  explorerPeek: sameLayout(value.applied, previousLayout)
                    ? value.explorerPeek
                    : null,
                },
          );
          if (!scope.signal.aborted) {
            publishNotice({
              key: 'preferences-undo',
              message:
                expectedLayout === undefined
                  ? 'Your saved sidebar has already changed.'
                  : 'Your saved layout has already changed.',
            });
          }
          return null;
        }
        const saved = await client.execute(uiSettings.patchSettings(next), options);
        const savedLayout = saved.settings['shell.layout'] ?? null;
        update((value) =>
          value.revision > saved.revision
            ? value
            : {
                ...value,
                applied: savedLayout,
                hidden: saved.settings['shell.sidebarHidden'] ?? {},
                revision: saved.revision,
                explorerPeek: sameLayout(value.applied, savedLayout) ? value.explorerPeek : null,
              },
        );
      } else {
        update((value) => ({
          ...value,
          applied: next['shell.layout'] === undefined ? value.applied : next['shell.layout'],
          hidden:
            next['shell.sidebarHidden'] === undefined
              ? value.hidden
              : (next['shell.sidebarHidden'] ?? {}),
          explorerPeek: next['shell.layout'] === undefined ? value.explorerPeek : null,
        }));
      }
      const previous: PreferencesPatch = {
        ...(next['shell.layout'] === undefined ? {} : { 'shell.layout': previousLayout }),
        ...(next['shell.sidebarHidden'] === undefined
          ? {}
          : {
              'shell.sidebarHidden':
                Object.keys(previousHidden).length === 0 ? null : previousHidden,
            }),
      };
      return scope.signal.aborted ? null : { previous };
    } catch {
      if (expected === undefined) {
        update((value) => ({ ...value, saveFailed: true }));
      } else if (!scope.signal.aborted) {
        publishNotice({
          key: 'preferences-undo',
          message: 'Could not restore your previous preferences.',
          action: {
            label: 'Retry',
            onAction: () => {
              if (connection.current === scope) void save(next, expected);
            },
          },
        });
      }
      return null;
    } finally {
      scope.pending = false;
      update((value) => ({ ...value, saving: false }));
    }
  }

  return {
    active: applied !== null || layoutChanged,
    welcome,
    theme: {
      mode: themeDraft === null ? theme.mode : themeDraft.mode,
      palette: themeDraft?.palette ?? theme.palette,
      ground: theme.ground,
    },
    setThemeDraft,
    hiddenDestinations,
    toggleDestination(id) {
      setSession((value) => {
        const { [id]: previous, ...rest } = value.draftHidden ?? value.hidden;
        const defaultHidden = hiddenByDefault(current.preset, id);
        const next = !(previous ?? defaultHidden);
        return { ...value, draftHidden: next === defaultHidden ? rest : { ...rest, [id]: next } };
      });
    },
    canResetSidebar: Object.keys(sidebarOverrides).length > 0,
    resetSidebar() {
      setSession((value) => ({ ...value, draftHidden: {} }));
    },
    draft,
    setDraft(next) {
      setSession((value) => ({ ...value, draft: next }));
    },
    changed,
    saving,
    saveFailed,
    visible: (setting) => visible(current, setting),
    explorer: (layoutChanged ? null : explorerPeek) ?? visible(current, 'explorer'),
    toggleExplorer() {
      if (connection.current?.pending === true) return;
      setSession((value) => {
        if (draft !== null) {
          return {
            ...value,
            draft: {
              ...draft,
              overrides: {
                ...draft.overrides,
                explorer: !(
                  (layoutChanged ? null : value.explorerPeek) ?? visible(draft, 'explorer')
                ),
              },
            },
          };
        }
        return { ...value, explorerPeek: !(value.explorerPeek ?? visible(current, 'explorer')) };
      });
    },
    open() {
      if (connection.current?.pending === true) return;
      setSession((value) => ({ ...value, draft: 'open' }));
    },
    cancel() {
      if (connection.current?.pending === true) return;
      setThemeDraft(null);
      setSession((value) => ({
        ...value,
        draft: null,
        draftHidden: null,
        welcome: false,
        saveFailed: false,
      }));
    },
    async apply(close) {
      if (draft === null || !changed) return;
      const scope = connection.current;
      const next: PreferencesPatch = {
        ...(layoutChanged ? { 'shell.layout': draft } : {}),
        ...(sidebarChanged
          ? {
              'shell.sidebarHidden':
                Object.keys(sidebarOverrides).length === 0 ? null : sidebarOverrides,
            }
          : {}),
      };
      const accountChanged = layoutChanged || sidebarChanged;
      const result = accountChanged ? await save(next) : { previous: {} };
      if (result === null || connection.current !== scope) return;
      if (themeChanged) theme.setTheme(themeDraft.mode, themeDraft.palette);
      close();
      const message =
        layoutChanged && !themeChanged && !sidebarChanged
          ? `Applied ${presetLabel(draft.preset)} layout`
          : 'Preferences applied';
      undo.push(message, async () => {
        if (connection.current !== scope) return;
        if (accountChanged) await save(result.previous, next);
        if (themeChanged) theme.setTheme(theme.mode, theme.palette);
      });
    },
  };
}

export interface ZenLayoutPreferences {
  readonly preview: Preview;
  readonly narrow: boolean;
}

export function ZenLayoutPreview({
  preview,
  narrow,
  anchor,
}: ZenLayoutPreferences & {
  readonly anchor: (ref: RefObject<HTMLButtonElement | null>) => ReactNode;
}): ReactNode {
  return (
    <Popover
      label="Preferences"
      open={preview.draft !== null}
      onOpenChange={(open) => {
        if (open) preview.open();
        else preview.cancel();
      }}
      dismissOnOutside={false}
      className="w-96"
      trigger={({ ref }) => anchor(ref)}
    >
      {({ close }) =>
        preview.draft === null ? null : (
          <LayoutPanel layout={preview.draft} preview={preview} narrow={narrow} close={close} />
        )
      }
    </Popover>
  );
}

function LayoutPanel({
  layout,
  preview,
  narrow,
  close,
}: {
  readonly layout: WorkspaceLayout;
  readonly preview: Preview;
  readonly narrow: boolean;
  readonly close: () => void;
}): ReactNode {
  const id = useId();
  const [selectedSection, setSection] = useState<'layout' | 'theme' | 'sidebar'>('layout');
  const showSidebar = layout.preset !== 'essentials';
  const section = !showSidebar && selectedSection === 'sidebar' ? 'layout' : selectedSection;
  const [custom, setCustom] = useState(false);
  const customizeButton = useRef<HTMLButtonElement>(null);
  return (
    <fieldset disabled={preview.saving} aria-busy={preview.saving} className="contents">
      <div className="flex items-baseline justify-between gap-2">
        <Text as="h2" variant="body" className="font-bold">
          {preview.welcome ? 'Make Nix yours' : 'Preferences'}
        </Text>
        <Text as="span" variant="caption" tone="muted" role="status">
          {preview.changed ? 'Live preview' : null}
        </Text>
      </div>
      {preview.welcome ? (
        <Text variant="bodySmall" tone="muted">
          Choose how Nix looks and which tools it shows. You can change these later in Preferences.
        </Text>
      ) : null}
      <Segmented
        label="Preference sections"
        value={section}
        onChange={setSection}
        options={[
          { value: 'layout', label: 'Layout' },
          { value: 'theme', label: 'Theme' },
          ...(showSidebar ? [{ value: 'sidebar', label: 'Sidebar' } as const] : []),
        ]}
      />
      {section === 'theme' ? (
        <ThemeFields
          ground={preview.theme.ground}
          palette={preview.theme.palette}
          onMode={(mode) => {
            preview.setThemeDraft({ mode, palette: preview.theme.palette });
          }}
          onPalette={(palette) => {
            preview.setThemeDraft({ mode: preview.theme.mode, palette });
          }}
        />
      ) : section === 'sidebar' ? (
        <div className="flex flex-col gap-2">
          <Text variant="caption" tone="muted">
            Choose what appears in the sidebar. Homebase, Trash, and Settings are always shown.
          </Text>
          <div className="grid grid-cols-2 gap-2">
            {sidebarChoices.map(({ id, label, icon }) => (
              <div key={label} className="flex min-w-0 items-center gap-1.5">
                <Icon icon={icon} size="sm" className="shrink-0 text-muted" />
                <Checkbox
                  label={label}
                  checked={id === null || !preview.hiddenDestinations.includes(id)}
                  disabled={id === null}
                  onChange={() => {
                    if (id !== null) preview.toggleDestination(id);
                  }}
                />
              </div>
            ))}
          </div>
          {preview.canResetSidebar ? (
            <Button variant="subtle" className="self-start" onClick={preview.resetSidebar}>
              Use layout defaults
            </Button>
          ) : null}
        </div>
      ) : custom ? (
        <div className="grid grid-cols-2 gap-2">
          {settingKeys
            .filter(
              (key) => !narrow || (key !== 'explorer' && key !== 'navigation' && key !== 'status'),
            )
            .map((key) => {
              const explicit = layout.overrides[key];
              return (
                <label key={key} className="grid min-w-0 content-start gap-1">
                  <Text as="span" variant="caption">
                    {settings[key]}
                  </Text>
                  <Select
                    aria-label={settings[key]}
                    value={explicit === undefined ? 'default' : explicit ? 'show' : 'hide'}
                    onChange={(event) => {
                      const value = event.target.value;
                      const overrides =
                        value === 'default'
                          ? Object.fromEntries(
                              Object.entries(layout.overrides).filter(
                                ([setting]) => setting !== key,
                              ),
                            )
                          : { ...layout.overrides, [key]: value === 'show' };
                      preview.setDraft({ ...layout, overrides });
                    }}
                  >
                    <option value="default">
                      Default · {defaultVisible(layout.preset, key) ? 'Show' : 'Hide'}
                    </option>
                    <option value="show">Always show</option>
                    <option value="hide">Always hide</option>
                  </Select>
                </label>
              );
            })}
          {Object.keys(layout.overrides).length === 0 ? null : (
            <Button
              variant="subtle"
              className="col-span-full justify-self-start"
              onClick={() => {
                preview.setDraft({ ...layout, overrides: {} });
                customizeButton.current?.focus();
              }}
            >
              Reset custom settings
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Layout presets">
            {presets.map(({ id: preset, label, detail }) => (
              <Button
                key={preset}
                variant="subtle"
                aria-label={label}
                aria-pressed={layout.preset === preset}
                aria-describedby={`${id}-${preset}`}
                className="h-auto min-w-0 flex-col gap-1.5 border border-transparent px-1 py-2 whitespace-normal aria-pressed:border-accent aria-pressed:bg-accent/12 aria-pressed:text-foreground"
                onClick={() => {
                  preview.setDraft({ ...layout, preset });
                }}
              >
                <LayoutSymbol preset={preset} narrow={narrow} />
                <Text as="span" variant="caption">
                  {label}
                </Text>
                <span className="sr-only" id={`${id}-${preset}`}>
                  {detail}
                </span>
              </Button>
            ))}
          </div>
          <Text variant="caption" tone="muted">
            {presets.find((preset) => preset.id === layout.preset)?.detail}
          </Text>
        </div>
      )}
      {section === 'layout' && custom ? (
        <Text variant="caption" tone="muted">
          Your saved layout follows you across devices.
        </Text>
      ) : null}
      {preview.saveFailed ? (
        <Text variant="caption" role="alert">
          Could not save your preferences. Try again.
        </Text>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-1 border-t border-divider pt-2">
        {section === 'layout' ? (
          <Button
            ref={customizeButton}
            variant="subtle"
            onClick={() => {
              setCustom(!custom);
            }}
          >
            {custom ? 'Back' : 'Customize'}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button variant="subtle" onClick={close}>
            {preview.welcome && !preview.changed ? 'Keep current' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            disabled={!preview.changed}
            onClick={() => {
              void preview.apply(close);
            }}
          >
            {preview.saving ? 'Saving…' : 'Apply preferences'}
          </Button>
        </div>
      </div>
    </fieldset>
  );
}

function LayoutSymbol({
  preset,
  narrow,
}: {
  readonly preset: Preset;
  readonly narrow: boolean;
}): ReactNode {
  const sidebar = !narrow && defaultVisible(preset, 'explorer');
  const left = sidebar ? '20' : '8';
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 44"
      className="h-12 w-full max-w-20 text-accent-text"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="60" height="40" rx="4" className="fill-background" />
      <path d="M2 10h60" />
      {sidebar ? (
        <path
          d={preset === 'full' ? 'M15 10v32M6 16h4m-4 5h4m-4 5h4' : 'M15 10v32M6 16h4m-4 5h4'}
        />
      ) : null}
      {defaultVisible(preset, 'status') ? <path d="M2 36h60" /> : null}
      <path d={`M${left} 23h29m-29 6h20`} className="opacity-55" />
      {preset === 'essentials' ? null : (
        <path d={`M${left} 16h4m3 0h4m3 0h4${preset === 'full' ? 'm3 0h4m3 0h4m3 0h4' : ''}`} />
      )}
      {preset === 'full' ? <path d="M49 22l3 2-3 2m6-4-2 4" /> : null}
    </svg>
  );
}
