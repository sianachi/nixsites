import { Button, Checkbox, Dialog, Icon, Input, Select, Tag, Text } from '@nix/ui';
import { Paperclip } from 'lucide-react';
import {
  attachments as attachmentsApi,
  files as filesApi,
  isNixApiError,
  structure,
  type AttachmentRow,
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
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useInRouteDialog } from '../shell/route-dialog-context';

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
        <Text variant="h3" as="h1">
          Attachments
        </Text>
      )}
      {children}
    </div>
  );
}

function reasonOf(error: unknown, fallback: string): string {
  return isNixApiError(error) && error.message ? error.message : fallback;
}

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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const iterator = useRef<AsyncIterator<AttachmentRow> | null>(null);

  const pull = useCallback(async (): Promise<readonly AttachmentRow[]> => {
    const taken: AttachmentRow[] = [];
    const source = iterator.current;
    while (source !== null && taken.length < PAGE) {
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

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const pages = client.paginate(
        attachmentsApi.listAttachments(
          workspaceId,
          { state: state === '' ? undefined : state, includeImages, expiring },
          PAGE,
        ),
      );
      iterator.current = pages[Symbol.asyncIterator]();
      setRows(await pull());
    } catch (reason) {
      setRows([]);
      setError(reasonOf(reason, 'Attachments could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId, state, includeImages, expiring, pull]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const showMore = async (): Promise<void> => {
    try {
      const next = await pull();
      setRows((current) => [...current, ...next]);
    } catch (reason) {
      setNotice(reasonOf(reason, 'More attachments could not be loaded.'));
    }
  };

  /** Runs one action, then reloads the list so every row shows the server's answer. */
  const act = useCallback(
    async (work: () => Promise<unknown>, failure: string): Promise<void> => {
      setNotice(null);
      try {
        await work();
        await load();
      } catch (reason) {
        setNotice(reasonOf(reason, failure));
      }
    },
    [load],
  );

  const filters = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <label className="flex items-center gap-2">
        <Text variant="note" as="span">
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
  } else if (rows.length === 0) {
    body = (
      <EmptyPanel
        title="No attachments"
        detail="Files in this workspace appear here. Images are hidden unless you show them."
      />
    );
  } else {
    body = (
      <>
        <ul aria-label="Attachments" className="flex flex-col gap-px">
          {rows.map((row) => (
            <AttachmentItem
              key={row.itemId}
              row={row}
              workspaceId={workspaceId}
              act={act}
              ask={setConfirm}
              notify={setNotice}
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
  readonly ask: (confirmation: Confirmation) => void;
  readonly notify: (message: string) => void;
}

function AttachmentItem({ row, workspaceId, act, ask, notify }: ItemProps): ReactElement {
  const client = useApiClient();
  const [open, setOpen] = useState(false);
  const [expiryDraft, setExpiryDraft] = useState(row.expiresAt?.slice(0, 10) ?? '');
  const [pins, setPins] = useState<readonly ReferencedBy[] | null>(null);
  const [pinsError, setPinsError] = useState<string | null>(null);
  const [link, setLink] = useState<PublicLink | null>(null);
  const [linkOff, setLinkOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const title = row.title === '' ? 'Untitled' : row.title;

  const setState = (next: FileVersionState): void => {
    void act(
      () => client.execute(attachmentsApi.setVersionState(row.itemId, row.shownVersionId, next)),
      `${title} could not be changed.`,
    );
  };

  const loadPins = useCallback(async (): Promise<void> => {
    setPinsError(null);
    try {
      const found: ReferencedBy[] = [];
      for await (const pin of client.paginate(attachmentsApi.listReferencedBy(row.itemId, 100))) {
        found.push(pin);
      }
      setPins(found);
    } catch (reason) {
      setPinsError(reasonOf(reason, 'Pins could not be loaded.'));
    }
  }, [client, row.itemId]);

  const loadLink = useCallback(async (): Promise<void> => {
    try {
      setLink(await client.query(attachmentsApi.getPublicLink(row.itemId), { forceRefresh: true }));
    } catch (reason) {
      if (isNixApiError(reason) && (reason.status === 404 || reason.status === 403)) {
        setLinkOff(true);
      }
    }
  }, [client, row.itemId]);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) {
      if (pins === null) void loadPins();
      if (row.hasPublicLink && link === null) void loadLink();
    }
  };

  const createLink = async (): Promise<void> => {
    try {
      setLink(await client.execute(attachmentsApi.createPublicLink(row.itemId)));
      setLinkOff(false);
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
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
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

  const saveExpiry = (value: string | null): void => {
    void act(
      () => client.execute(structure.setItemProperties(row.itemId, { expiry: value })),
      `The expiry of ${title} could not be changed.`,
    );
  };

  return (
    <li className="flex flex-col gap-2 rounded-sm px-2 py-2 hover:bg-surface">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Icon icon={Paperclip} size="sm" className="shrink-0 text-muted" />
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
          {row.hasPublicLink ? <Tag tone="muted">Public link</Tag> : null}
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
          <div className="flex flex-wrap gap-2">
            {row.shownVersionState === 'draft' ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setState('in_review');
                }}
              >
                Submit for review
              </Button>
            ) : null}
            {row.shownVersionState === 'draft' || row.shownVersionState === 'in_review' ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setState('approved');
                }}
              >
                Approve
              </Button>
            ) : null}
            {row.shownVersionState === 'approved' ? (
              <Button
                variant="danger"
                onClick={() => {
                  ask({
                    title: `Revoke the approved version of “${title}”?`,
                    detail:
                      'Public links to this version stop working. Pins keep pointing at it and show it as revoked.',
                    action: 'Revoke',
                    run: () =>
                      act(
                        () =>
                          client.execute(
                            attachmentsApi.setVersionState(
                              row.itemId,
                              row.shownVersionId,
                              'revoked',
                            ),
                          ),
                        `${title} could not be revoked.`,
                      ),
                  });
                }}
              >
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

          {linkOff ? (
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
                          ask({
                            title: `Remove “${holder}” as a holder of “${title}”?`,
                            detail: 'The file can be trashed again once nothing pins it.',
                            action: 'Remove',
                            run: () =>
                              act(async () => {
                                await client.execute(
                                  attachmentsApi.removeReference(pin.holderItemId, pin.id),
                                );
                                await loadPins();
                              }, 'The reference could not be removed.'),
                          });
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
