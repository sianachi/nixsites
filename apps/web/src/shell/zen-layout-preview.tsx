import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { writeStored } from '@nix/web-foundation/lib/stored-setting';
import { z } from 'zod';
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
type Preset = (typeof presets)[number]['id'];

interface Layout {
  readonly preset: Preset;
  readonly overrides: Partial<Record<Setting, boolean>>;
}

const storedLayout = z.object({
  preset: z.enum(presets.map(({ id }) => id)),
  overrides: z.partialRecord(z.enum(settingKeys), z.boolean()),
});

function readLayout(key: string | null): Layout | null {
  if (key === null) return null;
  try {
    const raw = browserStorage()?.getItem(key);
    return raw ? (storedLayout.safeParse(JSON.parse(raw)).data ?? null) : null;
  } catch {
    return null;
  }
}

function defaultVisible(preset: Preset, setting: Setting): boolean {
  return preset === 'full' || (preset === 'workspace' && setting !== 'advanced');
}

function visible(layout: Layout, setting: Setting): boolean {
  return layout.overrides[setting] ?? defaultVisible(layout.preset, setting);
}

function presetLabel(preset: Preset): string {
  return presets.find((entry) => entry.id === preset)?.label ?? preset;
}

interface Preview {
  readonly active: boolean;
  readonly draft: Layout | null;
  readonly setDraft: (layout: Layout) => void;
  readonly changed: boolean;
  readonly visible: (setting: Setting) => boolean;
  readonly explorer: boolean;
  readonly toggleExplorer: () => void;
  readonly open: () => void;
  readonly cancel: () => void;
  readonly apply: () => void;
}

interface LayoutSession {
  readonly key: string | null;
  readonly applied: Layout | null;
  readonly draft: Layout | null;
  readonly explorerPeek: boolean | null;
}

function startSession(key: string | null): LayoutSession {
  return { key, applied: readLayout(key), draft: null, explorerPeek: null };
}

export function useZenLayoutPreview(
  subject: string | null,
  native: Pick<Record<Setting, boolean>, 'explorer' | 'navigation' | 'status'>,
): Preview {
  const key = subject === null ? null : `nix.layout.${subject}`;
  const [session, setSession] = useState(() => startSession(key));
  const undo = useUndo();
  let currentSession = session;
  if (session.key !== key) {
    currentSession = startSession(key);
    setSession(currentSession);
  }
  const { applied, draft, explorerPeek } = currentSession;

  useEffect(() => {
    if (key !== null) writeStored(key, applied === null ? null : JSON.stringify(applied));
  }, [key, applied]);

  // Before the first apply, respect the person's current shell settings.
  const initial: Layout = {
    preset: 'full',
    overrides: {
      ...(native.explorer ? {} : { explorer: false }),
      ...(native.navigation ? {} : { navigation: false }),
      ...(native.status ? {} : { status: false }),
    },
  };
  const baseline = applied ?? initial;
  const changed =
    draft !== null &&
    (baseline.preset !== draft.preset ||
      settingKeys.some((setting) => baseline.overrides[setting] !== draft.overrides[setting]));
  const current = draft ?? baseline;

  return {
    active: applied !== null || changed,
    draft,
    setDraft(next) {
      setSession((value) => ({ ...value, draft: next }));
    },
    changed,
    visible: (setting) => visible(current, setting),
    explorer: (changed ? null : explorerPeek) ?? visible(current, 'explorer'),
    toggleExplorer() {
      setSession((value) => {
        if (value.draft !== null) {
          return {
            ...value,
            draft: {
              ...value.draft,
              overrides: {
                ...value.draft.overrides,
                explorer: !(
                  (changed ? null : value.explorerPeek) ?? visible(value.draft, 'explorer')
                ),
              },
            },
          };
        }
        return { ...value, explorerPeek: !(value.explorerPeek ?? visible(current, 'explorer')) };
      });
    },
    open() {
      setSession((value) => ({ ...value, draft: baseline }));
    },
    cancel() {
      setSession((value) => ({ ...value, draft: null }));
    },
    apply() {
      if (draft === null || !changed) return;
      setSession((value) => ({ ...value, applied: draft, draft: null, explorerPeek: null }));
      undo.push(`Applied ${presetLabel(draft.preset)} layout`, () => {
        setSession((value) =>
          value.key !== key || value.applied !== draft
            ? value
            : {
                ...value,
                applied,
                draft: value.draft === draft ? baseline : value.draft,
                explorerPeek: value.explorerPeek ?? explorerPeek,
              },
        );
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
  readonly layout: Layout;
  readonly preview: Preview;
  readonly narrow: boolean;
  readonly close: () => void;
}): ReactNode {
  const id = useId();
  const [custom, setCustom] = useState(false);
  const customizeButton = useRef<HTMLButtonElement>(null);
  return (
    <>
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
          Layout choices stay on this device.
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
              preview.apply();
              close();
            }}
          >
            Apply layout
          </Button>
        </div>
      </div>
    </>
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
