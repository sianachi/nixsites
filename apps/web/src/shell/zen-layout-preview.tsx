import { uiSettings, workspaceLayoutSchema, type WorkspaceLayout } from '@nix/api-client';
import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { writeStored } from '@nix/web-foundation/lib/stored-setting';
import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { Button, Popover, Select, Text, useUndo } from '@nix/ui';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';

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
    detail: 'Show navigation, collection controls, and tools for inserting content.',
  },
  {
    id: 'full',
    label: 'Full toolkit',
    detail: 'Add Markdown, suggestions, text width, and advanced formatting to the note editor.',
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
  return preset === 'full' || (preset === 'workspace' && setting !== 'advanced');
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

interface Preview {
  readonly active: boolean;
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
  let currentSession = session;
  if (session.key !== key) {
    currentSession = startSession(key);
    setSession(currentSession);
  }
  const { applied, explorerPeek, saving, saveFailed } = currentSession;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    connection.current = { signal, pending: false };
    const refresh = (): void => {
      if (client === null || key === null) return;
      void client.query(uiSettings.settings(), { signal, forceRefresh: true }).then(
        ({ settings: saved, revision }) => {
          const layout = saved['shell.layout'] ?? null;
          if (signal.aborted) return;
          setSession((value) => {
            if (value.key !== key || value.revision >= revision) return value;
            if (sameLayout(value.applied, layout)) return { ...value, revision };
            return { ...value, applied: layout, revision, explorerPeek: null };
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
  const changed = draft !== null && !sameLayout(baseline, draft);
  const current = draft ?? baseline;

  async function save(next: WorkspaceLayout | null, expected?: WorkspaceLayout) {
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
      let previous = applied;
      if (client !== null && key !== null) {
        const options = { signal: scope.signal, forceRefresh: true };
        const before = await client.query(uiSettings.settings(), options);
        previous = before.settings['shell.layout'] ?? null;
        if (expected !== undefined && !sameLayout(previous, expected)) {
          update((value) =>
            value.revision > before.revision
              ? value
              : { ...value, applied: previous, revision: before.revision, explorerPeek: null },
          );
          if (!scope.signal.aborted) {
            publishNotice({
              key: 'layout-undo',
              message: 'Your saved layout has already changed.',
            });
          }
          return null;
        }
        const saved = await client.execute(
          uiSettings.patchSettings({ 'shell.layout': next }),
          options,
        );
        update((value) =>
          value.revision > saved.revision
            ? value
            : {
                ...value,
                applied: saved.settings['shell.layout'] ?? null,
                revision: saved.revision,
                explorerPeek: null,
              },
        );
      } else {
        update((value) =>
          expected !== undefined && !sameLayout(value.applied, expected)
            ? value
            : { ...value, applied: next, explorerPeek: null },
        );
      }
      return scope.signal.aborted ? null : { previous };
    } catch {
      if (expected === undefined) {
        update((value) => ({ ...value, saveFailed: true }));
      } else if (!scope.signal.aborted) {
        publishNotice({
          key: 'layout-undo',
          message: 'Could not restore your previous layout.',
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
    active: applied !== null || changed,
    draft,
    setDraft(next) {
      setSession((value) => ({ ...value, draft: next }));
    },
    changed,
    saving,
    saveFailed,
    visible: (setting) => visible(current, setting),
    explorer: (changed ? null : explorerPeek) ?? visible(current, 'explorer'),
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
                explorer: !((changed ? null : value.explorerPeek) ?? visible(draft, 'explorer')),
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
      setSession((value) => ({ ...value, draft: null, saveFailed: false }));
    },
    async apply(close) {
      if (draft === null || !changed) return;
      const scope = connection.current;
      const result = await save(draft);
      if (result === null) return;
      close();
      undo.push(`Applied ${presetLabel(draft.preset)} layout`, async () => {
        if (connection.current !== scope) return;
        await save(result.previous, draft);
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
  const [custom, setCustom] = useState(false);
  const customizeButton = useRef<HTMLButtonElement>(null);
  return (
    <fieldset disabled={preview.saving} aria-busy={preview.saving} className="contents">
      <div className="flex items-baseline justify-between gap-2">
        <Text as="h2" variant="body" className="font-bold">
          {custom ? 'Customize layout' : 'Choose a layout'}
        </Text>
        <Text as="span" variant="caption" tone="muted" role="status">
          {preview.changed ? 'Live preview' : null}
        </Text>
      </div>
      {custom ? (
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
      )}
      {custom ? (
        <Text variant="caption" tone="muted">
          Your saved layout follows you across devices.
        </Text>
      ) : null}
      {preview.saveFailed ? (
        <Text variant="caption" role="alert">
          Could not save your layout. Try again.
        </Text>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-1 border-t border-divider pt-2">
        <Button
          ref={customizeButton}
          variant="subtle"
          onClick={() => {
            setCustom(!custom);
          }}
        >
          {custom ? 'Back' : 'Customize'}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="subtle" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!preview.changed}
            onClick={() => {
              void preview.apply(close);
            }}
          >
            {preview.saving ? 'Saving…' : 'Apply layout'}
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
      {sidebar ? <path d="M15 10v32M2 36h60M6 16h4m-4 5h4m-4 5h4" /> : null}
      <path d={`M${left} 23h29m-29 6h20`} className="opacity-55" />
      {preset === 'essentials' ? null : (
        <path d={`M${left} 16h4m3 0h4m3 0h4${preset === 'full' ? 'm3 0h4m3 0h4m3 0h4' : ''}`} />
      )}
      {preset === 'full' ? <path d="M49 22l3 2-3 2m6-4-2 4" /> : null}
    </svg>
  );
}
