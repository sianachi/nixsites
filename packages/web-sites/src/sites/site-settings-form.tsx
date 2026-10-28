import type {
  Site,
  SiteDatedCollection,
  SiteLayout,
  SiteNavLink,
  SiteRepublishMode,
  UpdateSiteInput,
} from '@nix/api-client';
import { Button, Checkbox, Dialog, Field, Input, Select, Text, Textarea } from '@nix/ui';
import { useEffect, useId, useState, type SyntheticEvent, type ReactNode } from 'react';

import { CHILD_LIMIT, type ChildChoice, type PropertyChoice } from './use-item-site';

type Save = (input: UpdateSiteInput) => Promise<string | null>;

const MODES: readonly { value: SiteRepublishMode; label: string }[] = [
  { value: 'manual', label: 'Only when I publish' },
  { value: 'auto', label: 'Automatically after edits' },
  { value: 'on_release', label: 'With each Nix release' },
];

type Look = Site['settings'];

const MARKS: readonly { value: Look['headingMark']; label: string }[] = [
  { value: 'square', label: 'Square' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'none', label: 'None' },
];

const TYPEFACES: readonly { value: Look['typeface']; label: string }[] = [
  { value: 'rounded', label: 'Rounded: Nunito Sans' },
  { value: 'serif', label: 'Book serif: Literata' },
  { value: 'legible', label: 'Hyperlegible: Atkinson Hyperlegible Next' },
];

const SPACINGS: readonly { value: Look['spacing']; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'airy', label: 'Airy' },
];

const SETTLE_TIMES: readonly { seconds: number; label: string }[] = [
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
];

/** One link per line, as `Label /path/`. Lines are checked by `navigationProblem` first. */
export function parseNavigation(text: string): SiteNavLink[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const split = line.lastIndexOf(' ');
      return { label: line.slice(0, split).trim(), path: line.slice(split + 1) };
    });
}

/** The first navigation line that cannot become a link, in words naming its line, or null. */
export function navigationProblem(text: string): string | null {
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const split = line.lastIndexOf(' ');
    const where = `Line ${String(index + 1)}`;
    if (split < 0) return `${where} needs a label, a space, then a path starting with /.`;
    if (!line.slice(split + 1).startsWith('/')) return `${where} needs a path starting with /.`;
  }
  return null;
}

function formatNavigation(links: readonly SiteNavLink[]): string {
  return links.map((link) => `${link.label} ${link.path}`).join('\n');
}

function useSaving(): {
  readonly saving: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly run: (body: () => Promise<string | null>, done: string) => Promise<void>;
} {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return {
    saving,
    message,
    error,
    run: async (body, done) => {
      setSaving(true);
      setMessage(null);
      setError(null);
      const refusal = await body();
      setSaving(false);
      if (refusal === null) setMessage(done);
      else setError(refusal);
    },
  };
}

function Outcome({
  message,
  error,
}: {
  readonly message: string | null;
  readonly error: string | null;
}): ReactNode {
  if (error !== null)
    return (
      <Text role="alert" variant="note">
        {error}
      </Text>
    );
  if (message !== null)
    return (
      <Text role="status" variant="note">
        {message}
      </Text>
    );
  return null;
}

interface SettingsDraft {
  readonly name: string;
  readonly description: string;
  readonly accent: string;
  readonly headingMark: Look['headingMark'];
  readonly typeface: Look['typeface'];
  readonly spacing: Look['spacing'];
  readonly layout: SiteLayout;
  readonly navigation: string;
  readonly footerText: string;
  readonly builtWithNix: boolean;
  readonly author: string;
  readonly noindex: boolean;
  readonly mode: SiteRepublishMode;
  readonly settle: number;
}

function draftOf(site: Site): SettingsDraft {
  return {
    name: site.settings.name,
    description: site.settings.description,
    accent: site.settings.accent,
    headingMark: site.settings.headingMark,
    typeface: site.settings.typeface,
    spacing: site.settings.spacing,
    layout: site.layout,
    navigation: formatNavigation(site.settings.navigation),
    footerText: site.settings.footerText,
    builtWithNix: site.settings.builtWithNix,
    author: site.settings.author ?? '',
    noindex: site.settings.noindex,
    mode: site.republishMode,
    settle: site.debounceSeconds,
  };
}

// Drafts are built by `draftOf` or spread from one, so their keys share an order.
function same(a: SettingsDraft, b: SettingsDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The site's look and when it rebuilds.
 *
 * The draft outlives the site being re-read while a build is polled. It is reseeded only after this
 * form's own save, or when the server copy changes while nothing here is unsaved; with unsaved
 * edits, a change made elsewhere is reported with a reload action instead of wiping them.
 */
export function SiteSettingsForm({
  site,
  onSave,
}: {
  readonly site: Site;
  readonly onSave: Save;
}): ReactNode {
  const server = draftOf(site);
  const [seed, setSeed] = useState(server);
  const [draft, setDraft] = useState(server);
  const [reseed, setReseed] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const modeHintId = useId();
  const save = useSaving();

  // Adjusting state while rendering, as React recommends for state derived from a changed prop.
  if (!same(seed, server) && (reseed || same(draft, seed))) {
    setReseed(false);
    setSeed(server);
    setDraft(server);
  }
  const changedElsewhere = !same(seed, server);

  function edit(change: Partial<SettingsDraft>): void {
    setDraft({ ...draft, ...change });
  }

  function reload(): void {
    setSeed(server);
    setDraft(server);
  }

  function store(): void {
    setConfirmAuto(false);
    void save.run(
      async () => {
        const refusal = await onSave({
          settings: {
            ...site.settings,
            name: draft.name.trim(),
            description: draft.description.trim(),
            accent: draft.accent,
            headingMark: draft.headingMark,
            typeface: draft.typeface,
            spacing: draft.spacing,
            navigation: parseNavigation(draft.navigation),
            footerText: draft.footerText,
            builtWithNix: draft.builtWithNix,
            author: draft.author.trim().length > 0 ? draft.author.trim() : null,
            noindex: draft.noindex,
          },
          layout: draft.layout,
          republishMode: draft.mode,
          debounceSeconds: draft.settle,
        });
        if (refusal === null) setReseed(true);
        return refusal;
      },
      draft.mode === 'auto'
        ? 'Settings saved. Saved edits now go public automatically.'
        : 'Settings saved. They reach the live site with the next publish.',
    );
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    const problem = navigationProblem(draft.navigation);
    setNavigationError(problem);
    if (problem !== null) return;
    if (draft.mode === 'auto' && site.republishMode !== 'auto') setConfirmAuto(true);
    else store();
  }

  return (
    <>
      <form className="flex flex-col gap-3" onSubmit={submit} aria-label="Site settings">
        {changedElsewhere ? (
          <div className="flex flex-col items-start gap-2">
            <Text variant="note" role="status">
              Settings changed elsewhere. Reload them to see the current copy; your unsaved changes
              here will be replaced.
            </Text>
            <Button variant="secondary" onClick={reload}>
              Reload settings
            </Button>
          </div>
        ) : null}
        <Field label="Site name" required>
          {(control) => (
            <Input
              {...control}
              value={draft.name}
              maxLength={120}
              onChange={(event) => {
                edit({ name: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label="Description" hint="One line, shown to search engines and link previews.">
          {(control) => (
            <Input
              {...control}
              value={draft.description}
              maxLength={300}
              onChange={(event) => {
                edit({ description: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label="Layout">
          {(control) => (
            <Select
              {...control}
              value={draft.layout}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === 'docs' || value === 'blog') edit({ layout: value });
              }}
            >
              <option value="docs">Docs: pages with a sidebar</option>
              <option value="blog">Blog: dated posts first</option>
            </Select>
          )}
        </Field>
        <Field label="Accent colour">
          {(control) => (
            <Input
              {...control}
              type="color"
              value={draft.accent}
              onChange={(event) => {
                edit({ accent: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label="Typeface">
          {(control) => (
            <Select
              {...control}
              value={draft.typeface}
              onChange={(event) => {
                const value = TYPEFACES.find((face) => face.value === event.currentTarget.value);
                if (value !== undefined) edit({ typeface: value.value });
              }}
            >
              {TYPEFACES.map((face) => (
                <option key={face.value} value={face.value}>
                  {face.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Heading mark"
          hint="The shape before section headings, cards and the site name."
        >
          {(control) => (
            <Select
              {...control}
              value={draft.headingMark}
              onChange={(event) => {
                const value = MARKS.find((mark) => mark.value === event.currentTarget.value);
                if (value !== undefined) edit({ headingMark: value.value });
              }}
            >
              {MARKS.map((mark) => (
                <option key={mark.value} value={mark.value}>
                  {mark.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Spacing">
          {(control) => (
            <Select
              {...control}
              value={draft.spacing}
              onChange={(event) => {
                const value = SPACINGS.find((space) => space.value === event.currentTarget.value);
                if (value !== undefined) edit({ spacing: value.value });
              }}
            >
              {SPACINGS.map((space) => (
                <option key={space.value} value={space.value}>
                  {space.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Top navigation"
          hint="One link per line: a label, a space, then a path such as /guide/."
          error={navigationError}
        >
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={draft.navigation}
              onChange={(event) => {
                edit({ navigation: event.currentTarget.value });
                setNavigationError(null);
              }}
            />
          )}
        </Field>
        <Field label="Footer text">
          {(control) => (
            <Input
              {...control}
              value={draft.footerText}
              maxLength={300}
              onChange={(event) => {
                edit({ footerText: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label="Author" hint="Who writes the site, named to search engines on each post.">
          {(control) => (
            <Input
              {...control}
              value={draft.author}
              maxLength={120}
              onChange={(event) => {
                edit({ author: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Checkbox
          label="Hide from search engines"
          checked={draft.noindex}
          onChange={(event) => {
            edit({ noindex: event.currentTarget.checked });
          }}
        />
        <Checkbox
          label="Show a “Built with Nix” link"
          checked={draft.builtWithNix}
          onChange={(event) => {
            edit({ builtWithNix: event.currentTarget.checked });
          }}
        />
        <Field label="Publish changes">
          {(control) => (
            <Select
              {...control}
              aria-describedby={modeHintId}
              value={draft.mode}
              onChange={(event) => {
                const chosen = MODES.find((option) => option.value === event.currentTarget.value);
                if (chosen !== undefined) edit({ mode: chosen.value });
              }}
            >
              {MODES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Text id={modeHintId} variant="note" tone="muted">
          {draft.mode === 'auto'
            ? 'Every saved edit to this item, or anything inside it, goes public automatically once edits have settled. Automatic builds run as you, so they include only what you can read.'
            : draft.mode === 'on_release'
              ? 'The site is rebuilt whenever this Nix server is updated.'
              : 'Nothing changes on the live site until you publish.'}
        </Text>
        {draft.mode === 'auto' ? (
          <Field label="Wait after the last edit">
            {(control) => (
              <Select
                {...control}
                value={String(draft.settle)}
                onChange={(event) => {
                  edit({ settle: Number(event.currentTarget.value) });
                }}
              >
                {SETTLE_TIMES.some((option) => option.seconds === draft.settle) ? null : (
                  <option value={String(draft.settle)}>{`${String(draft.settle)} seconds`}</option>
                )}
                {SETTLE_TIMES.map((option) => (
                  <option key={option.seconds} value={String(option.seconds)}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <div>
          <Button
            type="submit"
            variant="secondary"
            disabled={save.saving || draft.name.trim() === ''}
          >
            {save.saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
        <Outcome message={save.message} error={save.error} />
      </form>
      {confirmAuto ? (
        <Dialog
          open
          title="Publish every edit automatically?"
          onClose={() => {
            setConfirmAuto(false);
          }}
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirmAuto(false);
                }}
              >
                Cancel
              </Button>
              <Button onClick={store}>Publish automatically</Button>
            </>
          }
        >
          <Text>
            Every saved edit to this item, or anything inside it, will go public on its own once
            edits settle, without asking again. Search engines and archives may copy each version.
          </Text>
        </Dialog>
      ) : null}
    </>
  );
}

/** Collections whose children are dated posts, and which properties the blog layout reads. */
export function SiteDatedCollections({
  site,
  onSave,
  listChildren,
  listProperties,
}: {
  readonly site: Site;
  readonly onSave: Save;
  readonly listChildren: (parentId: string) => Promise<readonly ChildChoice[]>;
  readonly listProperties: (collectionId: string) => Promise<readonly PropertyChoice[]>;
}): ReactNode {
  const [choices, setChoices] = useState<readonly ChildChoice[] | null>(null);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [choicesAttempt, setChoicesAttempt] = useState(0);
  const [draft, setDraft] = useState<SiteDatedCollection | null>(null);
  const [properties, setProperties] = useState<readonly PropertyChoice[] | null>(null);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);
  const [propertiesAttempt, setPropertiesAttempt] = useState(0);
  // The fields of each saved collection, so the list can name them by label rather than key.
  const [known, setKnown] = useState<Readonly<Record<string, readonly PropertyChoice[]>>>({});
  const save = useSaving();
  const rootId = site.rootItemId;

  // Loaded on mount, so the saved collections are listed by title.
  useEffect(() => {
    let live = true;
    listChildren(rootId)
      .then((children) => {
        if (!live) return;
        setChoicesError(null);
        setChoices(children);
      })
      .catch(() => {
        if (live) setChoicesError('The items inside this site could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [choicesAttempt, listChildren, rootId]);

  const savedIds = site.datedCollections.map((entry) => entry.itemId).join(' ');
  useEffect(() => {
    let live = true;
    for (const id of savedIds.split(' ').filter((value) => value !== '')) {
      listProperties(id)
        .then((loaded) => {
          if (live) setKnown((current) => ({ ...current, [id]: loaded }));
        })
        // A field whose label could not be read is named by its key instead.
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [savedIds, listProperties]);

  const collectionId = draft?.itemId ?? '';
  useEffect(() => {
    if (collectionId === '') return;
    let live = true;
    listProperties(collectionId)
      .then((loaded) => {
        if (!live) return;
        setPropertiesError(null);
        setProperties(loaded);
      })
      .catch(() => {
        if (live) setPropertiesError('The collection’s fields could not be loaded.');
      });
    return () => {
      live = false;
    };
  }, [collectionId, listProperties, propertiesAttempt]);

  const titleOf = (id: string): string => {
    if (id === rootId) return 'The whole site';
    const title = choices?.find((choice) => choice.id === id)?.title;
    return title === undefined ? 'A collection' : title === '' ? 'Untitled' : title;
  };
  const labelOf = (id: string, key: string): string =>
    known[id]?.find((property) => property.key === key)?.label ?? key;
  const dateProperties = (properties ?? []).filter((p) => p.type === 'date');

  function remove(itemId: string): void {
    void save.run(
      () =>
        onSave({
          datedCollections: site.datedCollections.filter((entry) => entry.itemId !== itemId),
        }),
      'Dated collection removed.',
    );
  }

  function propertySelect(
    label: string,
    value: string | null,
    options: readonly PropertyChoice[],
    onChange: (value: string | null) => void,
    required = false,
  ): ReactNode {
    return (
      <Field label={label} required={required}>
        {(control) => (
          <Select
            {...control}
            value={value ?? ''}
            onChange={(event) => {
              const chosen = event.currentTarget.value;
              onChange(chosen === '' ? null : chosen);
            }}
          >
            <option value="">{required ? 'Choose a property' : 'None'}</option>
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {site.datedCollections.length === 0 ? (
        <Text variant="note" tone="muted">
          No dated collections. Add one to list its children as posts, newest first, with feeds.
        </Text>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Dated collections">
          {site.datedCollections.map((entry) => (
            <li key={entry.itemId} className="flex items-center justify-between gap-2">
              <Text variant="note" as="span">
                {`${titleOf(entry.itemId)}, dated by ${labelOf(entry.itemId, entry.dateProperty)}`}
              </Text>
              <Button
                variant="ghost"
                aria-label={`Remove ${titleOf(entry.itemId)}`}
                disabled={save.saving}
                onClick={() => {
                  remove(entry.itemId);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {draft === null ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft({
                itemId: '',
                dateProperty: '',
                tagsProperty: null,
                coverProperty: null,
                summaryProperty: null,
              });
            }}
          >
            Add a dated collection
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          aria-label="New dated collection"
          onSubmit={(event) => {
            event.preventDefault();
            const added = draft;
            void save.run(async () => {
              const refusal = await onSave({
                datedCollections: [
                  ...site.datedCollections.filter((e) => e.itemId !== added.itemId),
                  added,
                ],
              });
              if (refusal === null) setDraft(null);
              return refusal;
            }, 'Dated collection added.');
          }}
        >
          {choicesError === null ? null : (
            <div role="alert" className="flex flex-col items-start gap-2">
              <Text variant="note">{choicesError}</Text>
              <Button
                variant="secondary"
                onClick={() => {
                  setChoicesAttempt((value) => value + 1);
                }}
              >
                Retry
              </Button>
            </div>
          )}
          <Field
            label="Collection"
            required
            {...(choices !== null && choices.length >= CHILD_LIMIT
              ? { hint: `Showing the first ${String(CHILD_LIMIT)} items inside the site.` }
              : {})}
          >
            {(control) => (
              <Select
                {...control}
                value={draft.itemId}
                disabled={choices === null}
                onChange={(event) => {
                  setProperties(null);
                  setPropertiesError(null);
                  setDraft({ ...draft, itemId: event.currentTarget.value, dateProperty: '' });
                }}
              >
                <option value="">{choices === null ? 'Loading…' : 'Choose a collection'}</option>
                <option value={rootId}>The whole site</option>
                {(choices ?? []).map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.title === '' ? 'Untitled' : choice.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {draft.itemId === '' ? null : propertiesError !== null ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <Text variant="note">{propertiesError}</Text>
              <Button
                variant="secondary"
                onClick={() => {
                  setPropertiesError(null);
                  setPropertiesAttempt((value) => value + 1);
                }}
              >
                Retry
              </Button>
            </div>
          ) : properties === null ? (
            <Text variant="note" tone="muted" role="status">
              Loading the collection’s fields…
            </Text>
          ) : dateProperties.length === 0 ? (
            <Text variant="note" role="status">
              This collection has no date field. Add one in its Fields pane first.
            </Text>
          ) : (
            <>
              {propertySelect(
                'Date',
                draft.dateProperty,
                dateProperties,
                (value) => {
                  setDraft({ ...draft, dateProperty: value ?? '' });
                },
                true,
              )}
              {propertySelect('Tags', draft.tagsProperty, properties, (value) => {
                setDraft({ ...draft, tagsProperty: value });
              })}
              {propertySelect('Cover image', draft.coverProperty, properties, (value) => {
                setDraft({ ...draft, coverProperty: value });
              })}
              {propertySelect('Summary', draft.summaryProperty, properties, (value) => {
                setDraft({ ...draft, summaryProperty: value });
              })}
            </>
          )}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={save.saving || draft.itemId === '' || draft.dateProperty === ''}
            >
              Add
            </Button>
          </div>
        </form>
      )}
      <Outcome message={save.message} error={save.error} />
    </div>
  );
}
