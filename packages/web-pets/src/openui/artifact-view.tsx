import { items, type Item } from '@nix/api-client';
import { createParser, isReactiveAssign } from '@openuidev/lang-core';
import { Button, Skeleton, Text } from '@nix/ui';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { fencedState, programIn, stateIn, storableState } from './fence';
import OpenUiBlock from './openui-block';
import { nixLibrary } from './library';

type Saved = ReturnType<typeof stateIn>;

const parser = createParser(nixLibrary.toJSONSchema());

function describeState(program: string | null): {
  readonly defaults: Record<string, unknown>;
  readonly labels: ReadonlyMap<string, string>;
} {
  const parsed = program === null ? null : parser.parse(program);
  const labels = new Map<string, string>();
  const seen = new Set<object>();
  function visit(value: unknown): void {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    if ('type' in value && value.type === 'element' && 'props' in value) {
      const props = value.props;
      if (typeof props === 'object' && props !== null) {
        if ('label' in props && typeof props.label === 'string' && 'value' in props) {
          const binding = props.value;
          if (isReactiveAssign(binding)) labels.set(binding.target, props.label);
          else if (
            typeof binding === 'object' &&
            binding !== null &&
            'k' in binding &&
            binding.k === 'StateRef' &&
            'n' in binding &&
            typeof binding.n === 'string'
          ) {
            labels.set(binding.n, props.label);
          }
        }
        Object.values(props).forEach(visit);
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    }
  }
  visit(parsed?.root);
  return { defaults: parsed?.stateDeclarations ?? {}, labels };
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Empty';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(displayValue).join(', ') || 'Empty';
  if (typeof value === 'object' && 'value' in value) return displayValue(value.value);
  return JSON.stringify(value);
}

type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'ready';
      readonly item: Item;
      readonly program: string | null;
      /** The values saved in the body, as stored. */
      readonly saved: Saved;
      readonly stateDescription: ReturnType<typeof describeState>;
    };

/**
 * An artifact item drawn live: the first `openui-lang` program in its body, scoped to the
 * artifact's own workspace, starting from the values saved beside it in the same body (an
 * `openui-state` block), so everyone who opens it sees the same values and a lock covers them.
 * The companion changes its program through the body-edit tools.
 */
export default function ArtifactView({ itemId }: { readonly itemId: string }): ReactNode {
  const client = useApiClient();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const changesId = useId();
  const [notice, setNotice] = useState('');
  // Changed values, kept here until the viewer chooses to share them (security fix M1).
  const [unsaved, setUnsaved] = useState<{ text: string; values: Record<string, unknown> } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const { createCompanionBodies } = await import('@nix/companion');
        const [item, body] = await Promise.all([
          client.query(items.itemById(itemId), { signal: controller.signal, forceRefresh: true }),
          createCompanionBodies(client).read(itemId, controller.signal),
        ]);
        const markdown = (body as { markdown?: unknown }).markdown;
        const text = typeof markdown === 'string' ? markdown : '';
        const program = programIn(text);
        if (!controller.signal.aborted)
          setLoaded({
            status: 'ready',
            item,
            program,
            saved: stateIn(text),
            stateDescription: describeState(program),
          });
      } catch {
        if (!controller.signal.aborted) setLoaded({ status: 'failed' });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [attempt, client, itemId]);

  /**
   * Values change on every click and keystroke, but they are shared with everyone who opens the
   * artifact, so they are saved only when the viewer says so, after seeing exactly what will be
   * stored. Saving on every change would let a program copy what this viewer can read (a query
   * result, through `@Set`) into a property other members read, without anyone deciding to.
   */
  function changed(state: Record<string, unknown>) {
    const text = storableState(state);
    if (text === null) {
      setUnsaved(null);
      setNotice('These values are too large to keep; they last until you leave.');
      return;
    }
    setNotice('');
    setUnsaved({ text, values: state });
  }

  /**
   * Appends `appended` when the body has no such block yet. Otherwise the block is the whole text
   * of its own code block, so a passage edit replaces exactly `previous`, planned and applied
   * against the body as it is now; everything else in the body stays as it is.
   */
  async function writeBlock(previous: string | null, appended: string, replace: string) {
    const { createCompanionBodies } = await import('@nix/companion');
    const bodies = createCompanionBodies(client);
    const signal = new AbortController().signal;
    if (previous === null) await bodies.append(itemId, appended, signal);
    else {
      const edit = { kind: 'passage' as const, find: previous, replace };
      const plan = await bodies.planEdit(itemId, edit, signal);
      await bodies.applyEdit(itemId, edit, plan.fingerprint, signal);
    }
  }

  async function share(text: string) {
    if (loaded.status !== 'ready') return;
    setSaving(true);
    try {
      // shortcut: the last save wins when two people save the same artifact at once; merge per
      // $variable if shared artifacts start to see concurrent use.
      await writeBlock(loaded.saved?.text ?? null, fencedState(text), text);
      setLoaded({ ...loaded, saved: stateIn(fencedState(text)) });
      setUnsaved((current) => (current?.text === text ? null : current));
    } catch {
      setNotice("These values can't be saved here: you can use this artifact but not edit it.");
    } finally {
      setSaving(false);
    }
  }

  if (loaded.status === 'loading')
    return (
      <div className="p-4">
        <span role="status" className="sr-only">
          Loading the artifact…
        </span>
        <Skeleton shape="block" />
      </div>
    );
  if (loaded.status === 'failed')
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        <Text role="alert">This artifact could not be loaded.</Text>
        <Button
          variant="secondary"
          onClick={() => {
            setLoaded({ status: 'loading' });
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  const previous = { ...loaded.stateDescription.defaults, ...loaded.saved?.values };
  const changes = Object.entries(unsaved?.values ?? {}).filter(
    ([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key]),
  );
  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      {loaded.program === null ? (
        <Text variant="note">This artifact has no program yet. Ask your companion to add one.</Text>
      ) : (
        <OpenUiBlock
          key={loaded.item.id}
          source={loaded.program}
          workspaceIds={[loaded.item.workspaceId]}
          fallback={
            <Text variant="note" role="alert">
              This artifact could not render. Ask your companion to fix it.
            </Text>
          }
          initialState={loaded.saved?.values}
          onStateChange={changed}
        />
      )}
      {unsaved !== null && changes.length > 0 ? (
        <section aria-labelledby={changesId} className="flex min-w-0 flex-col items-start gap-2">
          <Text as="h2" variant="h5" id={changesId}>
            Changes everyone will see
          </Text>
          <dl className="grid max-h-40 w-full gap-2 overflow-auto rounded-md border border-divider p-3">
            {changes.map(([key, value]) => (
              <div key={key} className="flex min-w-0 flex-wrap justify-between gap-2">
                <Text as="dt" variant="bodySmall" className="wrap-anywhere">
                  {loaded.stateDescription.labels.get(key) ??
                    key.replace(/^\$/, '').replace(/[_-]/g, ' ')}
                </Text>
                <Text as="dd" variant="bodySmall" className="wrap-anywhere whitespace-pre-wrap">
                  {displayValue(value)}
                </Text>
              </div>
            ))}
          </dl>
          <Button variant="secondary" disabled={saving} onClick={() => void share(unsaved.text)}>
            Save values for everyone
          </Button>
        </section>
      ) : null}
      {notice ? (
        <Text variant="note" role="status">
          {notice}
        </Text>
      ) : null}
    </div>
  );
}
