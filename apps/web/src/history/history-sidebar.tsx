import { Button, Dialog, Icon, Input, Tag, Text } from '@nix/ui';
import { EditorContent, useEditor } from '@tiptap/react';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';

import { formatFullDate, formatTime } from '@nix/web-foundation/lib/date-format';
import { proseRoot } from '@nix/web-editor/editor/prose';
import { readingExtensions } from '@nix/web-editor/editor/reading-extensions';
import { blockTexts, diffBlocks, type DiffEntry } from './block-diff';

/**
 * The history sidebar, built as pure components driven entirely by props.
 *
 * `use-document-history.ts` (owned elsewhere, see `docs/plans/version-history.md`) is where the
 * data actually comes from - fetching, paging, and the mutations. Nothing here imports it or
 * `history-api.ts`; every one of these types is this file's own, shaped to match the plan's
 * `Revision`/`NamedVersion` records so the hook is a drop-in once it lands.
 */

/** A run of consecutive updates by one actor - see `docs/plans/version-history.md`. */
export interface HistoryRevision {
  readonly seq: number;
  readonly fromSeq: number;
  readonly actorId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly updateCount: number;
  readonly name: string | null;
}

/** A revision somebody named. */
export interface HistoryNamedVersion {
  readonly seq: number;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The document reconstructed at one `seq`. */
export interface HistoryStateAtSeq {
  readonly document: unknown;
  readonly plaintext: string;
}

export interface HistorySidebarProps {
  readonly revisions: readonly HistoryRevision[];
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly namedVersions: readonly HistoryNamedVersion[];
  readonly headSeq: number | null;
  readonly loading: boolean;
  readonly refusal: string | null;
  /** The live document, as ProseMirror JSON - what a restored or diffed revision is measured against. */
  readonly currentDocument: unknown;
  readonly stateAt: (seq: number) => Promise<HistoryStateAtSeq | null>;
  readonly onRestore: (seq: number) => void;
  readonly onName: (seq: number, name: string) => void;
  readonly onRemoveName: (seq: number) => void;
  readonly onClose: () => void;
}

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 120;

function validateName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < NAME_MIN_LENGTH) return 'Enter a name.';
  if (trimmed.length > NAME_MAX_LENGTH)
    return `Names are at most ${String(NAME_MAX_LENGTH)} characters.`;
  return null;
}

/** The first eight characters of an actor id - enough to tell two apart, short enough for a row. */
function shortActorId(actorId: string): string {
  return actorId.length > 8 ? `${actorId.slice(0, 8)}…` : actorId;
}

function timeLabel(iso: string): string {
  return formatTime(new Date(iso));
}

function timeRangeLabel(revision: HistoryRevision): string {
  const start = timeLabel(revision.startedAt);
  const end = timeLabel(revision.endedAt);
  return start === end ? start : `${start}–${end}`;
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getFullYear())}-${String(date.getMonth())}-${String(date.getDate())}`;
}

function dayLabel(iso: string): string {
  return formatFullDate(new Date(iso));
}

interface RevisionGroup {
  readonly key: string;
  readonly label: string;
  readonly revisions: readonly HistoryRevision[];
}

/**
 * Groups revisions by calendar day, newest day first. `revisions` is already newest-first (the
 * API orders it that way); grouping only has to fold consecutive same-day entries together, not
 * re-sort anything.
 */
function groupByDay(revisions: readonly HistoryRevision[]): readonly RevisionGroup[] {
  const groups: RevisionGroup[] = [];
  for (const revision of revisions) {
    const key = dayKey(revision.endedAt);
    const last = groups.at(-1);
    if (last?.key === key) {
      (last.revisions as HistoryRevision[]).push(revision);
    } else {
      groups.push({ key, label: dayLabel(revision.endedAt), revisions: [revision] });
    }
  }
  return groups;
}

/**
 * The inline "name a version" form: one field, one confirm, one cancel. Shared by the "name the
 * current version" control at the top of the panel and the "name this revision" action beside a
 * selected one.
 */
function NameForm({
  initialName,
  onSubmit,
  onCancel,
}: {
  readonly initialName: string;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void => {
    event.preventDefault();
    const problem = validateName(value);
    if (problem !== null) {
      setError(problem);
      return;
    }
    onSubmit(value.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1" aria-label="Name this version">
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onCancel();
            }
          }}
          placeholder="Version name"
          aria-invalid={error !== null || undefined}
          className="flex-1"
        />
        <Button type="submit" variant="secondary">
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error !== null ? (
        <Text variant="note" tone="muted" role="alert">
          {error}
        </Text>
      ) : null}
    </form>
  );
}

/** A read-only rendering of one revision's document, dressed the same as the live editor. */
function RevisionDocument({ document }: { readonly document: unknown }): ReactElement {
  const editor = useEditor(
    {
      extensions: readingExtensions,
      content: document as Record<string, unknown>,
      editable: false,
      editorProps: {
        attributes: { class: `${proseRoot} outline-none`, 'aria-label': 'Selected revision' },
      },
    },
    [document],
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <EditorContent editor={editor} />
    </div>
  );
}

function diffEntryClassName(kind: DiffEntry['kind']): string {
  if (kind === 'added') return 'bg-accent/10 px-2 py-1';
  if (kind === 'removed') return 'px-2 py-1 text-muted line-through';
  if (kind === 'changed') return 'flex flex-col gap-1 px-2 py-1';
  return 'px-2 py-1';
}

/** The block diff between the selected revision and the current document. */
function BlockDiffList({ entries }: { readonly entries: readonly DiffEntry[] }): ReactElement {
  return (
    <ul className="flex flex-col gap-1 px-2 py-2" aria-label="Changes since this version">
      {entries.map((entry, index) => (
        // Block plaintext is not a stable identity - two blocks can read the same - so the entry's
        // position in this already-ordered, never-reordered list is the key.
        <li key={index} className={diffEntryClassName(entry.kind)}>
          {entry.kind === 'changed' ? (
            <>
              <Text variant="bodySmall" tone="muted" className="line-through">
                {entry.before}
              </Text>
              <Text variant="bodySmall" className="bg-accent/10">
                {entry.after}
              </Text>
            </>
          ) : (
            <Text variant="bodySmall">{entry.before ?? entry.after ?? ''}</Text>
          )}
        </li>
      ))}
    </ul>
  );
}

export function HistorySidebar(props: HistorySidebarProps): ReactElement {
  const {
    revisions,
    hasMore,
    loadMore,
    namedVersions,
    headSeq,
    loading,
    refusal,
    currentDocument,
    stateAt,
    onRestore,
    onName,
    onRemoveName,
    onClose,
  } = props;

  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [selectedState, setSelectedState] = useState<HistoryStateAtSeq | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [namingSeq, setNamingSeq] = useState<number | null>(null);
  const [namingHead, setNamingHead] = useState(false);
  const [confirmingRestoreSeq, setConfirmingRestoreSeq] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Deferred to a microtask rather than called synchronously in the effect body: React flags a
    // setState reachable from the first line of an effect as a likely render loop, even here
    // where it is one-shot per `selectedSeq` change and guarded by `cancelled` on the way out.
    queueMicrotask(() => {
      if (cancelled) return;
      if (selectedSeq === null) {
        setSelectedState(null);
        return;
      }
      setStateLoading(true);
      setSelectedState(null);
      void stateAt(selectedSeq)
        .then((result) => {
          if (!cancelled) setSelectedState(result);
        })
        .finally(() => {
          if (!cancelled) setStateLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSeq, stateAt]);

  const nameBySeq = new Map(namedVersions.map((version) => [version.seq, version.name]));
  const groups = groupByDay(revisions);
  const selectedRevision = revisions.find((revision) => revision.seq === selectedSeq) ?? null;
  const headName = headSeq === null ? null : (nameBySeq.get(headSeq) ?? null);

  useEffect(() => {
    // On `window`, matching the convention `sidebar-drawer.tsx` sets: something nested that owns
    // its own Escape - the restore confirmation `<Dialog>` - stops the keydown at its own element
    // before it can reach here, so the innermost open thing is always the one that closes.
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <aside aria-label="History" className="flex h-full min-h-0 flex-col gap-4 bg-background p-4">
      <div className="flex items-center justify-between gap-2">
        <Text variant="h3" as="h2">
          History
        </Text>
        <Button variant="icon" aria-label="Close history" onClick={onClose}>
          <Icon icon={X} size="sm" />
        </Button>
      </div>

      {refusal !== null ? (
        <Text variant="note" role="alert">
          {refusal}
        </Text>
      ) : null}

      <div className="flex flex-col gap-1 border-b border-divider pb-4">
        {headName !== null ? (
          <div className="flex items-center gap-2">
            <Tag tone="accent">{headName}</Tag>
            <Text variant="note" tone="muted">
              Current version
            </Text>
            <Button
              variant="ghost"
              onClick={() => {
                if (headSeq !== null) onRemoveName(headSeq);
              }}
            >
              Remove name
            </Button>
          </div>
        ) : namingHead ? (
          <NameForm
            initialName=""
            onSubmit={(name) => {
              if (headSeq !== null) onName(headSeq, name);
              setNamingHead(false);
            }}
            onCancel={() => {
              setNamingHead(false);
            }}
          />
        ) : (
          <Button
            variant="secondary"
            disabled={headSeq === null}
            onClick={() => {
              setNamingHead(true);
            }}
          >
            Name current version
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 w-64 shrink-0 flex-col gap-3 overflow-y-auto">
          {loading && revisions.length === 0 ? (
            <Text variant="note" tone="muted">
              Loading history…
            </Text>
          ) : null}
          {!loading && revisions.length === 0 && refusal === null ? (
            <Text variant="note" tone="muted">
              No history yet.
            </Text>
          ) : null}
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <Text variant="caption" tone="muted">
                {group.label}
              </Text>
              <ul className="flex flex-col gap-1">
                {group.revisions.map((revision) => {
                  const name = revision.name ?? nameBySeq.get(revision.seq) ?? null;
                  const selected = revision.seq === selectedSeq;
                  return (
                    <li key={revision.seq}>
                      <button
                        type="button"
                        aria-current={selected || undefined}
                        onClick={() => {
                          setSelectedSeq(revision.seq);
                          setNamingSeq(null);
                        }}
                        className={`flex w-full flex-col items-start gap-0.5 border px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                          selected
                            ? 'border-accent-text bg-accent/10'
                            : 'border-transparent hover:bg-foreground/5'
                        }`}
                      >
                        <Text variant="bodySmall">{shortActorId(revision.actorId)}</Text>
                        <Text variant="note" tone="muted">
                          {timeRangeLabel(revision)} · {revision.updateCount}{' '}
                          {revision.updateCount === 1 ? 'update' : 'updates'}
                        </Text>
                        {name !== null ? <Tag tone="accent">{name}</Tag> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {hasMore ? (
            <Button variant="secondary" onClick={loadMore}>
              Load more
            </Button>
          ) : null}
        </div>

        {selectedRevision !== null ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-l border-divider pl-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setNamingSeq(selectedRevision.seq);
                }}
              >
                Name this version
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmingRestoreSeq(selectedRevision.seq);
                }}
              >
                Restore
              </Button>
            </div>

            {namingSeq === selectedRevision.seq ? (
              <NameForm
                initialName={selectedRevision.name ?? ''}
                onSubmit={(name) => {
                  onName(selectedRevision.seq, name);
                  setNamingSeq(null);
                }}
                onCancel={() => {
                  setNamingSeq(null);
                }}
              />
            ) : null}

            {stateLoading ? (
              <Text variant="note" tone="muted">
                Loading this version…
              </Text>
            ) : selectedState === null ? (
              <Text variant="note" tone="muted" role="status">
                This version is no longer available.
              </Text>
            ) : (
              <>
                <RevisionDocument document={selectedState.document} />
                <BlockDiffList
                  entries={diffBlocks(
                    blockTexts(selectedState.document),
                    blockTexts(currentDocument),
                  )}
                />
              </>
            )}
          </div>
        ) : null}
      </div>

      <Dialog
        open={confirmingRestoreSeq !== null}
        title="Restore this version?"
        onClose={() => {
          setConfirmingRestoreSeq(null);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmingRestoreSeq(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirmingRestoreSeq !== null) onRestore(confirmingRestoreSeq);
                setConfirmingRestoreSeq(null);
              }}
            >
              Restore
            </Button>
          </>
        }
      >
        <Text variant="body">
          This replaces the current document with this version. Nothing in history is deleted -
          restoring adds a new revision on top.
        </Text>
      </Dialog>
    </aside>
  );
}
