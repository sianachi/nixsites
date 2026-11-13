import {
  Button,
  Checkbox,
  Dialog,
  Icon,
  Input,
  Select,
  Tag,
  Text,
  useFlash,
  useUndo,
} from '@nix/ui';
import {
  agentRecords,
  attachments as attachmentsApi,
  files as filesApi,
  isNixApiError,
  structure,
  type AttachmentRow,
  type CursorPage,
  type FileVersionState,
  type PublicLink,
  type ReferencedBy,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { selectedItemSearch } from '@nix/web-platform/routing/selected-item';
import { useCapabilities } from '@nix/web-platform/session/capabilities-context';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useInRouteDialog } from '@nix/web-foundation/layout/route-dialog-context';
import { fileIcon } from '@nix/web-views/drive/drive-icons';

const PAGE = 50;
const STATE_LABEL: Record<FileVersionState, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  revoked: 'Revoked',
};

function Frame({ children }: { readonly children: ReactNode }): ReactElement {
  const inDialog = useInRouteDialog();
  return (
    <div
      className={`${paneScroller} flex flex-col gap-4 break-words ${inDialog ? '' : 'p-3 sm:p-4'}`}
    >
      {inDialog ? null : (
        <Text variant="h3" as="h2">
          Attachments
        </Text>
      )}
      {children}
    </div>
  );
}

/** Walks a cursor-paginated list one item at a time, fetching each page when the last runs out. */
async function* walk<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    yield* page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}

function reasonOf(error: unknown, fallback: string): string {
  return isNixApiError(error) && error.message ? error.message : fallback;
}

const DAY = 86_400_000;
const SOON = 30 * DAY;

/** What makes a file need a look: a version in review, or an expiry that is past or close. */
function expiryWarning(row: AttachmentRow): 'Expired' | 'Expiring soon' | null {
  if (row.expiresAt === null || row.shownVersionState === 'revoked') return null;
  const left = new Date(row.expiresAt).getTime() - Date.now();
  if (left < 0) return 'Expired';
  return left <= SOON ? 'Expiring soon' : null;
}

function needsAttention(row: AttachmentRow): boolean {
  return row.shownVersionState === 'in_review' || expiryWarning(row) !== null;
}

const manyFiles = (n: number): string => (n === 1 ? '1 file' : `${String(n)} files`);

/** One server write on one file, with the write that reverses it when the server allows one. */
interface Change {
  readonly row: AttachmentRow;
  readonly apply: () => Promise<unknown>;
  readonly revert?: () => Promise<unknown>;
}

type Client = ReturnType<typeof useApiClient>;

/** Only draft to in review can be taken back; approving and revoking cannot. */
function stateChange(client: Client, row: AttachmentRow, next: FileVersionState): Change {
  const write = (to: FileVersionState) => (): Promise<unknown> =>
    client.execute(attachmentsApi.setVersionState(row.itemId, row.shownVersionId, to));
  const undoable = row.shownVersionState === 'draft' && next === 'in_review';
  return {
    row,
    apply: write(next),
    ...(undoable ? { revert: write('draft') } : {}),
  };
}

/** `iso` is the new expiry, or null to clear it; undo puts the old one back. */
function expiryChange(client: Client, row: AttachmentRow, iso: string | null): Change {
  const write = (expiry: string | null) => (): Promise<unknown> =>
    client.execute(structure.setItemProperties(row.itemId, { expiry }));
  return { row, apply: write(iso), revert: write(row.expiresAt) };
}

function linkChange(client: Client, row: AttachmentRow): Change {
  return {
    row,
    apply: () => client.execute(attachmentsApi.createPublicLink(row.itemId)),
    revert: () => client.execute(attachmentsApi.revokePublicLink(row.itemId)),
  };
}

/** A chosen date lasts to the end of that day where the person is. */
const endOfDay = (date: string): string => new Date(`${date}T23:59:59`).toISOString();

type Commit = (
  changes: readonly Change[],
  words: { readonly done: string; readonly failure: string },
) => Promise<void>;

interface Confirmation {
  readonly title: string;
  readonly detail: string;
  readonly action: string;
  readonly run: () => Promise<void>;
}

export function AttachmentsPage(): ReactElement {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const [state, setState] = useState<FileVersionState | ''>('');
  const [includeImages, setIncludeImages] = useState(false);
  const [expiring, setExpiring] = useState(false);
  const [rows, setRows] = useState<readonly AttachmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [attention, setAttention] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [bulkDate, setBulkDate] = useState('');
  const undo = useUndo();
  const { publicLinks } = useCapabilities();
  const shown = useRef(PAGE);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const iterator = useRef<AsyncIterator<AttachmentRow> | null>(null);

  const pull = useCallback(async (limit: number): Promise<readonly AttachmentRow[]> => {
    const taken: AttachmentRow[] = [];
    const source = iterator.current;
    while (source !== null && taken.length < limit) {
      const next = await source.next();
      if (next.done === true) {
        iterator.current = null;
        break;
      }
      taken.push(next.value);
    }
    setMore(iterator.current !== null);
    return taken;
  }, []);

  /** Fetches the list again; `count` keeps as many rows as were on screen, so an action never jumps back to page one. */
  const load = useCallback(
    async (count: number = PAGE): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const pages = walk((cursor) =>
          client.query(
            attachmentsApi.listAttachments(workspaceId, {
              state: state === '' ? undefined : state,
              includeImages,
              expiring,
              limit: PAGE,
              cursor,
            }),
            { forceRefresh: true },
          ),
        );
        iterator.current = pages[Symbol.asyncIterator]();
        setRows(await pull(count));
      } catch (reason) {
        setRows([]);
        setError(reasonOf(reason, 'Attachments could not be loaded.'));
      } finally {
        setLoading(false);
      }
    },
    [client, workspaceId, state, includeImages, expiring, pull],
  );

  useEffect(() => {
    shown.current = Math.max(PAGE, rows.length);
  }, [rows]);

  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);

  const showMore = async (): Promise<void> => {
    try {
      const next = await pull(PAGE);
      setRows((current) => [...current, ...next]);
    } catch (reason) {
      setNotice(reasonOf(reason, 'More attachments could not be loaded.'));
    }
  };

  /** Runs one action, then reloads the list (same length) so every row shows the server's answer. */
  const act = useCallback(
    async (work: () => Promise<unknown>, failure: string): Promise<void> => {
      setNotice(null);
      try {
        await work();
        await load(shown.current);
      } catch (reason) {
        setNotice(reasonOf(reason, failure));
      }
    },
    [load],
  );

  /**
   * Applies the same kind of change to one or many files. Undo is pushed only when every change
   * has a reverse (the server cannot move an approved version anywhere but to revoked), and it
   * reverses just these files.
   */
  const commit: Commit = useCallback(
    async (changes, words) => {
      if (changes.length === 0) return;
      setNotice(null);
      const results = await Promise.allSettled(changes.map((change) => change.apply()));
      const done = changes.filter((_, index) => results[index]?.status === 'fulfilled');
      const failed = results.find((result) => result.status === 'rejected');
      if (failed !== undefined || done.length === 0) {
        setNotice(
          failed === undefined
            ? words.failure
            : `${reasonOf(failed.reason, words.failure)}${
                done.length > 0
                  ? ` ${String(done.length)} of ${String(changes.length)} changed.`
                  : ''
              }`,
        );
      }
      if (done.length > 0) {
        const reverts = done.flatMap((change) =>
          change.revert === undefined ? [] : [change.revert],
        );
        if (reverts.length === done.length) {
          undo.push(words.done, async () => {
            await Promise.allSettled(reverts.map((revert) => revert()));
            await load(shown.current);
          });
        } else if (failed === undefined) {
          setNotice(words.done);
        }
      }
      await load(shown.current);
    },
    [load, undo],
  );

  const needing = rows.filter(needsAttention).length;
  const visible = attention ? rows.filter(needsAttention) : rows;
  const selected = visible.filter((row) => selection.has(row.itemId));
  const toggleRow = (id: string, on: boolean): void => {
    setSelection((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const bulk = (
    eligible: (row: AttachmentRow) => boolean,
    change: (row: AttachmentRow) => Change,
    done: string,
    failure: string,
  ): void => {
    const picked = selected.filter(eligible);
    const skipped = selected.length - picked.length;
    void commit(picked.map(change), {
      done: `${done} ${manyFiles(picked.length)}${skipped > 0 ? `, ${String(skipped)} skipped` : ''}`,
      failure,
    });
  };
  const canReview = (row: AttachmentRow): boolean => row.shownVersionState === 'draft';
  const canApprove = (row: AttachmentRow): boolean =>
    row.shownVersionState === 'draft' || row.shownVersionState === 'in_review';
  const canRevoke = (row: AttachmentRow): boolean => row.shownVersionState === 'approved';
  const canClear = (row: AttachmentRow): boolean => row.expiresAt !== null;
  const canLink = (row: AttachmentRow): boolean => !row.hasPublicLink;

  const filters = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Button
        variant={attention ? 'primary' : 'secondary'}
        aria-pressed={attention}
        onClick={() => {
          setAttention(!attention);
        }}
      >
        Needs attention ({needing})
      </Button>
      <label className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <Text variant="note" as="span" className="shrink-0">
          State
        </Text>
        <Select
          aria-label="State"
          value={state}
          onChange={(event) => {
            setState(event.target.value as FileVersionState | '');
          }}
        >
          <option value="">Any state</option>
          {(Object.keys(STATE_LABEL) as FileVersionState[]).map((key) => (
            <option key={key} value={key}>
              {STATE_LABEL[key]}
            </option>
          ))}
        </Select>
      </label>
      <Checkbox
        label="Show images"
        checked={includeImages}
        onChange={(event) => {
          setIncludeImages(event.target.checked);
        }}
      />
      <Checkbox
        label="Expiring only"
        checked={expiring}
        onChange={(event) => {
          setExpiring(event.target.checked);
        }}
      />
    </div>
  );

  let body: ReactNode;
  if (loading && rows.length === 0) {
    body = <LoadingPanel label="attachments" />;
  } else if (error !== null) {
    body = (
      <ErrorPanel
        title="Attachments could not be loaded"
        detail={error}
        action={
          <Button
            onClick={() => {
              void load();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyPanel
        title={attention ? 'Nothing needs attention' : 'No attachments'}
        detail="Files in this workspace appear here. Images are hidden unless you show them."
      />
    );
  } else {
    const count = (eligible: (row: AttachmentRow) => boolean): number =>
      selected.filter(eligible).length;
    body = (
      <>
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border border-divider bg-background px-2 py-1">
          <Checkbox
            aria-label="Select all shown files"
            label={
              selected.length > 0
                ? `${String(selected.length)} selected`
                : 'Select files to act on several at once'
            }
            checked={selected.length === visible.length}
            indeterminate={selected.length > 0 && selected.length < visible.length}
            onChange={(event) => {
              setSelection(
                event.target.checked ? new Set(visible.map((r) => r.itemId)) : new Set(),
              );
            }}
          />
          {selected.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={count(canReview) === 0}
                onClick={() => {
                  bulk(
                    canReview,
                    (row) => stateChange(client, row, 'in_review'),
                    'Submitted for review:',
                    'Those files could not be submitted for review.',
                  );
                }}
              >
                {`Submit for review (${String(count(canReview))})`}
              </Button>
              <Button
                variant="secondary"
                disabled={count(canApprove) === 0}
                onClick={() => {
                  bulk(
                    canApprove,
                    (row) => stateChange(client, row, 'approved'),
                    'Approved',
                    'Those files could not be approved.',
                  );
                }}
              >
                {`Approve (${String(count(canApprove))})`}
              </Button>
              <Button
                variant="danger"
                disabled={count(canRevoke) === 0}
                onClick={() => {
                  const picked = selected.filter(canRevoke);
                  setConfirm({
                    title: `Revoke ${manyFiles(picked.length)}?`,
                    detail:
                      'Public links to these versions stop working. Pins keep pointing at them and show them as revoked.',
                    action: 'Revoke',
                    run: () =>
                      commit(
                        picked.map((row) => stateChange(client, row, 'revoked')),
                        {
                          done: `Revoked ${manyFiles(picked.length)}`,
                          failure: 'Those files could not be revoked.',
                        },
                      ),
                  });
                }}
              >
                {`Revoke (${String(count(canRevoke))})`}
              </Button>
              <Input
                type="date"
                aria-label="Expiry date for selected files"
                value={bulkDate}
                onChange={(event) => {
                  setBulkDate(event.target.value);
                }}
              />
              <Button
                variant="secondary"
                disabled={bulkDate === ''}
                onClick={() => {
                  bulk(
                    (row) => row.expiresAt?.slice(0, 10) !== bulkDate,
                    (row) => expiryChange(client, row, endOfDay(bulkDate)),
                    `Set expiry (${bulkDate}) on`,
                    'The expiry could not be changed for all selected files.',
                  );
                }}
              >
                {`Set expiry (${String(selected.length)})`}
              </Button>
              <Button
                variant="secondary"
                disabled={count(canClear) === 0}
                onClick={() => {
                  bulk(
                    canClear,
                    (row) => expiryChange(client, row, null),
                    'Cleared expiry on',
                    'The expiry could not be cleared for all selected files.',
                  );
                }}
              >
                {`Clear expiry (${String(count(canClear))})`}
              </Button>
              {publicLinks ? (
                <Button
                  variant="secondary"
                  disabled={count(canLink) === 0}
                  onClick={() => {
                    bulk(
                      canLink,
                      (row) => linkChange(client, row),
                      'Created public links for',
                      'Public links could not be created for all selected files.',
                    );
                  }}
                >
                  {`Create public link (${String(count(canLink))})`}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                onClick={() => {
                  setSelection(new Set());
                }}
              >
                Clear selection
              </Button>
            </div>
          )}
        </div>
        <ul aria-label="Attachments" className="flex flex-col gap-px">
          {visible.map((row) => (
            <AttachmentItem
              key={row.itemId}
              row={row}
              workspaceId={workspaceId}
              act={act}
              commit={commit}
              ask={setConfirm}
              notify={setNotice}
              selected={selection.has(row.itemId)}
              onSelect={toggleRow}
            />
          ))}
        </ul>
        {more ? (
          <Button
            variant="secondary"
            onClick={() => {
              void showMore();
            }}
          >
            Show more
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <Frame>
      {filters}
      {visible.some(canApprove) ? (
        <Text as="p" variant="note" tone="muted">
          Approve marks this version as ready to use. Approved versions can be pinned or shared with
          a public link where sharing is enabled. Approval alone leaves the file private.
        </Text>
      ) : null}
      {notice === null ? null : (
        <div role="status" className="rounded-md border border-divider p-3">
          <Text variant="note" as="p">
            {notice}
          </Text>
        </div>
      )}
      {body}
      <Dialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        onClose={() => {
          setConfirm(null);
        }}
        initialFocus={cancelRef}
        actions={
          <>
            <Button
              ref={cancelRef}
              variant="secondary"
              onClick={() => {
                setConfirm(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const run = confirm?.run;
                setConfirm(null);
                if (run !== undefined) void run();
              }}
            >
              {confirm?.action ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">{confirm?.detail ?? ''}</Text>
      </Dialog>
    </Frame>
  );
}

interface ItemProps {
  readonly row: AttachmentRow;
  readonly workspaceId: string;
  readonly act: (work: () => Promise<unknown>, failure: string) => Promise<void>;
  readonly commit: Commit;
  readonly ask: (confirmation: Confirmation) => void;
  readonly notify: (message: string) => void;
  readonly selected: boolean;
  readonly onSelect: (itemId: string, on: boolean) => void;
}

function AttachmentItem({
  row,
  workspaceId,
  act,
  commit,
  ask,
  notify,
  selected,
  onSelect,
}: ItemProps): ReactElement {
  const client = useApiClient();
  const undo = useUndo();
  const [open, setOpen] = useState(false);
  const [expiryDraft, setExpiryDraft] = useState(row.expiresAt?.slice(0, 10) ?? '');
  const [pins, setPins] = useState<readonly ReferencedBy[] | null>(null);
  const [pinsError, setPinsError] = useState<string | null>(null);
  const [link, setLink] = useState<PublicLink | null>(null);
  const [linkOff, setLinkOff] = useState(false);
  const { publicLinks } = useCapabilities();
  const [copied, setCopied] = useState(false);
  const title = row.title === '' ? 'Untitled' : row.title;
  const flash = useFlash(
    `${row.shownVersionState}|${row.expiresAt ?? ''}|${String(row.hasPublicLink)}`,
  );
  const warning = expiryWarning(row);
  const FileGlyph = fileIcon(row.title, undefined, row.mediaType);
  const quoted = `“${title}”`;

  const setState = (next: FileVersionState, done: string): void => {
    void commit([stateChange(client, row, next)], {
      done: `${done} ${quoted}`,
      failure: `${title} could not be changed.`,
    });
  };

  const revoke = (): void => {
    ask({
      title: `Revoke the approved version of ${quoted}?`,
      detail:
        'Public links to this version stop working. Pins keep pointing at it and show it as revoked.',
      action: 'Revoke',
      run: () =>
        commit([stateChange(client, row, 'revoked')], {
          done: `Revoked ${quoted}; its public links stop working`,
          failure: `${title} could not be revoked.`,
        }),
    });
  };

  const loadPins = useCallback(async (): Promise<void> => {
    setPinsError(null);
    try {
      const found: ReferencedBy[] = [];
      const fetchPins = (cursor?: string): Promise<CursorPage<ReferencedBy>> =>
        client.query(agentRecords.listReferencedBy(row.itemId, 100, cursor), {
          forceRefresh: true,
        });
      for await (const pin of walk(fetchPins)) found.push(pin);
      setPins(found);
    } catch (reason) {
      setPinsError(reasonOf(reason, 'Pins could not be loaded.'));
    }
  }, [client, row.itemId]);

  const loadLink = useCallback(async (): Promise<PublicLink | null> => {
    try {
      const found = await client.query(attachmentsApi.getPublicLink(row.itemId), {
        forceRefresh: true,
      });
      setLink(found);
      return found;
    } catch (reason) {
      if (isNixApiError(reason) && (reason.status === 404 || reason.status === 403)) {
        setLinkOff(true);
      }
      return null;
    }
  }, [client, row.itemId]);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) {
      if (pins === null) void loadPins();
      if (publicLinks && row.hasPublicLink && link === null) void loadLink();
    }
  };

  const createLink = async (): Promise<void> => {
    try {
      setLink(await client.execute(attachmentsApi.createPublicLink(row.itemId)));
      setLinkOff(false);
      undo.push(`Created a public link for ${quoted}`, async () => {
        await client.execute(attachmentsApi.revokePublicLink(row.itemId));
        setLink(null);
        await act(() => Promise.resolve(), '');
      });
      await act(() => Promise.resolve(), '');
    } catch (reason) {
      if (isNixApiError(reason) && (reason.status === 404 || reason.status === 403)) {
        setLinkOff(true);
      } else {
        notify(reasonOf(reason, `A public link for ${title} could not be created.`));
      }
    }
  };

  const copy = async (): Promise<void> => {
    const found = link ?? (await loadLink());
    if (found === null) {
      notify('The link could not be copied. Select it and copy it by hand.');
      return;
    }
    try {
      await navigator.clipboard.writeText(found.url);
      setCopied(true);
      notify(`Copied the link for ${quoted}`);
    } catch {
      notify('The link could not be copied. Select it and copy it by hand.');
    }
  };

  const download = async (): Promise<void> => {
    try {
      const capability = await client.query(filesApi.downloadFile(row.itemId, row.shownVersionId), {
        forceRefresh: true,
      });
      window.open(capability.url, '_blank', 'noopener');
    } catch (reason) {
      notify(reasonOf(reason, `${title} could not be downloaded.`));
    }
  };

  const saveExpiry = (date: string | null): void => {
    void commit([expiryChange(client, row, date === null ? null : endOfDay(date))], {
      done: date === null ? `Cleared expiry of ${quoted}` : `Expiry of ${quoted} set to ${date}`,
      failure: `The expiry of ${title} could not be changed.`,
    });
  };

  const linkControls = publicLinks && !linkOff;

  return (
    <li
      {...flash}
      className={`flex flex-col gap-2 rounded-sm px-2 py-2 hover:bg-surface ${
        selected ? 'bg-surface' : ''
      } ${warning !== null || row.shownVersionState === 'in_review' ? 'border-l-2 border-accent-text' : ''}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Checkbox
            aria-label={`Select ${title}`}
            checked={selected}
            onChange={(event) => {
              onSelect(row.itemId, event.target.checked);
            }}
          />
          <Icon icon={FileGlyph} size="sm" className="shrink-0 text-muted" />
          <Link
            to={`/w/${workspaceId}?${selectedItemSearch(row.itemId)}`}
            className="min-w-0 flex-1 break-words sm:truncate"
          >
            <Text variant="note" as="span">
              {title}
            </Text>
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-7 sm:pl-0">
          <Tag tone={row.shownVersionState === 'approved' ? 'accent' : 'neutral'}>
            {STATE_LABEL[row.shownVersionState]}
          </Tag>
          {warning === null ? null : <Tag>{warning}</Tag>}
          {row.hasPublicLink ? <Tag tone="muted">Public link</Tag> : null}
          {row.shownVersionState === 'approved' ? (
            <Button variant="danger" aria-label={`Revoke ${title}`} onClick={revoke}>
              Revoke
            </Button>
          ) : row.shownVersionState === 'revoked' ? null : (
            <Button
              variant="secondary"
              aria-label={`Approve ${title}`}
              onClick={() => {
                setState('approved', 'Approved');
              }}
            >
              Approve
            </Button>
          )}
          {linkControls ? (
            row.hasPublicLink ? (
              <Button
                variant="secondary"
                aria-label={`Copy public link for ${title}`}
                onClick={() => {
                  void copy();
                }}
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            ) : (
              <Button
                variant="secondary"
                aria-label={`Create public link for ${title}`}
                onClick={() => {
                  void createLink();
                }}
              >
                Create link
              </Button>
            )
          ) : null}
          <Button
            variant="secondary"
            aria-expanded={open}
            aria-label={`Manage ${title}`}
            onClick={toggle}
          >
            Manage
          </Button>
        </div>
      </div>
      {open ? (
        <div className="flex flex-col gap-3 pl-7">
          <div className="flex flex-wrap items-center gap-3">
            {row.expiresAt === null ? null : (
              <Text variant="note" as="span">
                Expires {row.expiresAt.slice(0, 10)}
              </Text>
            )}
            {row.sourceItemId === null ? null : (
              <Link
                to={`/w/${workspaceId}?${selectedItemSearch(row.sourceItemId)}`}
                className="underline"
              >
                <Text variant="note" as="span">
                  Source note
                </Text>
              </Link>
            )}
            <Text variant="note" as="span">
              {row.pinCount === 1 ? '1 pin' : `${String(row.pinCount)} pins`}
            </Text>
          </div>
          <div className="flex flex-wrap gap-2">
            {row.shownVersionState === 'draft' ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setState('in_review', 'Submitted for review:');
                }}
              >
                Submit for review
              </Button>
            ) : null}
            {row.shownVersionState === 'draft' || row.shownVersionState === 'in_review' ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setState('approved', 'Approved');
                }}
              >
                Approve
              </Button>
            ) : null}
            {row.shownVersionState === 'approved' ? (
              <Button variant="danger" onClick={revoke}>
                Revoke
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                void download();
              }}
            >
              Download
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              aria-label={`Expiry date for ${title}`}
              value={expiryDraft}
              onChange={(event) => {
                setExpiryDraft(event.target.value);
              }}
            />
            <Button
              variant="secondary"
              disabled={expiryDraft === ''}
              onClick={() => {
                saveExpiry(expiryDraft);
              }}
            >
              Set expiry
            </Button>
            {row.expiresAt === null ? null : (
              <Button
                variant="secondary"
                onClick={() => {
                  setExpiryDraft('');
                  saveExpiry(null);
                }}
              >
                Clear expiry
              </Button>
            )}
          </div>

          {!linkControls ? (
            <Text variant="note" as="p">
              Public links are turned off for this workspace or server, so this file cannot be
              shared by link.
            </Text>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {link === null ? (
                row.hasPublicLink ? null : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void createLink();
                    }}
                  >
                    Create public link
                  </Button>
                )
              ) : (
                <>
                  <Input readOnly aria-label={`Public link for ${title}`} value={link.url} />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void copy();
                    }}
                  >
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                </>
              )}
              {row.hasPublicLink ? (
                <Button
                  variant="danger"
                  onClick={() => {
                    ask({
                      title: `Revoke the public link for “${title}”?`,
                      detail: 'Anyone holding the link loses access within a minute.',
                      action: 'Revoke link',
                      run: () =>
                        act(async () => {
                          await client.execute(attachmentsApi.revokePublicLink(row.itemId));
                          setLink(null);
                        }, `The public link for ${title} could not be revoked.`),
                    });
                  }}
                >
                  Revoke public link
                </Button>
              ) : null}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Text variant="note" as="h3">
              Used by
            </Text>
            {pinsError !== null ? (
              <Text variant="note" as="p">
                {pinsError}
              </Text>
            ) : pins === null ? (
              <Text variant="note" as="p">
                Loading…
              </Text>
            ) : pins.length === 0 ? (
              <Text variant="note" as="p">
                Nothing points at this file.
              </Text>
            ) : (
              <ul aria-label={`References to ${title}`} className="flex flex-col gap-1">
                {pins.map((pin) => {
                  const holder =
                    !pin.holderAvailable || pin.holderTitle === null
                      ? 'Unavailable item'
                      : pin.holderTitle;
                  return (
                    <li key={pin.id} className="flex flex-wrap items-center gap-2">
                      <Text variant="note" as="span">
                        {holder}
                        {pin.targetFileVersionId === null ? ' (mention)' : ' (pin)'}
                      </Text>
                      <Button
                        variant="secondary"
                        aria-label={`Unpin ${holder}`}
                        onClick={() => {
                          void act(async () => {
                            await client.execute(
                              agentRecords.removeReference(pin.holderItemId, pin.id),
                            );
                            undo.push(`Removed ${holder} as a holder of ${quoted}`, async () => {
                              await client.execute(
                                agentRecords.addReference(pin.holderItemId, {
                                  targetItemId: row.itemId,
                                  targetFileVersionId: pin.targetFileVersionId ?? undefined,
                                  role: pin.role ?? undefined,
                                }),
                              );
                              await loadPins();
                              await act(() => Promise.resolve(), '');
                            });
                            await loadPins();
                          }, 'The reference could not be removed.');
                        }}
                      >
                        Unpin
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}
