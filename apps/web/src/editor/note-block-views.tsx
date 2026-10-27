import { nixEditingExtensions } from '@nix/editor-schema';
import { isNixApiError, locks } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
  type ReactNodeViewProps,
} from '@tiptap/react';
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ySyncPlugin, yUndoPlugin } from 'y-prosemirror';
import type { Plugin } from '@tiptap/pm/state';
import { CollaborationHistoryKeymap } from './collaboration-history-keymap';
import * as Y from 'yjs';
import { useAuth } from '../auth/auth-provider';
import { useApiClient } from '../api/api-client-provider';
import { useSelectedItem } from '../routing/selected-item';
import { startCollabSync, FRAGMENT_NAME, type SyncState, type CollabSync } from './collab-sync';
import { discardBodyCache, documentScope, onBodyForgetting, sealItemBodies } from './body-cache';
import {
  useReference,
  useRefreshReference,
  ReferenceResolutionProvider,
} from './reference-resolution';
import { NoteImageView } from './note-image-view';

// An embedded artifact brings the OpenUI renderer, loaded only when one is embedded.
const ArtifactView = lazy(() => import('../openui/artifact-view'));
import { ReferenceView } from './reference-view';
import { proseClasses, proseRoot } from './prose';

interface SourceState {
  readonly status: SyncState;
  readonly doc: Y.Doc | null;
  readonly notice: string | null;
}
interface SourceEntry {
  snapshot: SourceState;
  listeners: Set<() => void>;
  start: () => void;
  release: () => void;
  stop: () => void;
}
interface SourceOptions {
  readonly localScope?: { readonly subject: string; readonly workspaceId: string } | undefined;
}
const Sources = createContext<
  (SourceOptions & { readonly entries: Map<string, SourceEntry> }) | null
>(null);
export function NoteSourcesProvider({
  children,
  localScope,
}: SourceOptions & { readonly children: ReactNode }): ReactNode {
  const [entries] = useState(() => new Map<string, SourceEntry>());
  useEffect(
    () => () => {
      for (const entry of entries.values()) entry.stop();
    },
    [entries],
  );
  return <Sources.Provider value={{ entries, localScope }}>{children}</Sources.Provider>;
}
const unavailable: SourceState = { status: 'connecting', doc: null, notice: null };
function useSource(targetId: string): SourceState {
  const options = useContext(Sources);
  const entries = options?.entries;
  const subject = options?.localScope?.subject;
  const reference = useReference(targetId);
  const workspaceId =
    reference.status === 'resolved' ? reference.workspaceId : options?.localScope?.workspaceId;
  const client = useApiClient();
  const { getAccessToken } = useAuth();
  const refreshReference = useRefreshReference();
  // One subscription belongs to one account and source.
  const entry = useMemo<SourceEntry>(() => {
    const entryKey = JSON.stringify([subject, workspaceId, targetId]);
    const existing = entries?.get(entryKey);
    if (existing !== undefined) return existing;
    let stop = (): void => {
      /* No transport until the first subscriber. */
    };
    let active = false;
    let release = (): void => undefined;
    const created: SourceEntry = {
      snapshot: unavailable,
      listeners: new Set(),
      start: () => {
        if (active) return;
        active = true;
        const doc = new Y.Doc();
        let revision = 0;
        let confirmedRevision = 0;
        let confirming = false;
        let stopped = false;
        let retry: ReturnType<typeof setTimeout> | null = null;
        let sync: CollabSync | undefined;
        const controller = new AbortController();
        const scope = documentScope(subject, workspaceId, targetId, 'note');
        const trackLocalUpdate = (
          _update: Uint8Array,
          _origin: unknown,
          _doc: Y.Doc,
          transaction: Y.Transaction,
        ): void => {
          if (transaction.local) revision += 1;
        };
        doc.on('update', trackLocalUpdate);
        const publish = (): void => {
          const visible =
            created.snapshot.status === 'live' || created.snapshot.status === 'readonly';
          created.snapshot = { ...created.snapshot, doc: visible ? doc : null };
          for (const listener of created.listeners) listener();
        };
        const connect = (cacheScope: string | undefined): void => {
          if (stopped) return;
          sync = startCollabSync({
            itemId: targetId,
            doc,
            fragmentName: FRAGMENT_NAME,
            getAccessToken,
            cacheScope,
            ...(cacheScope === undefined ? {} : { draftScope: cacheScope }),
            onState: (status) => {
              created.snapshot = { status, doc: null, notice: null };
              publish();
              if (status === 'live')
                queueMicrotask(() => {
                  release();
                });
            },
            onNotice: ({ code }) => {
              if (code === 'access_revoked') {
                refreshReference(targetId);
                created.snapshot = { status: 'offline', doc: null, notice: null };
                publish();
              } else if (code !== 'read_only') {
                created.snapshot = {
                  ...created.snapshot,
                  notice:
                    'The latest source edit has not been saved. Keep this note open while it reconnects.',
                };
                publish();
              }
            },
          });
        };
        stop = () => {
          if (stopped) return;
          stopped = true;
          active = false;
          if (retry !== null) clearTimeout(retry);
          controller.abort();
          unsubscribe();
          doc.off('update', trackLocalUpdate);
          sync?.destroy();
          doc.destroy();
          created.snapshot = unavailable;
        };
        const unsubscribe = onBodyForgetting((forgetting) => {
          if (scope === undefined) return;
          const affected =
            forgetting.kind === 'everything' ||
            (forgetting.kind === 'scope' && forgetting.scope === scope) ||
            (forgetting.kind === 'item' && scope.startsWith(forgetting.prefix)) ||
            (forgetting.kind === 'unreachable' &&
              (subject !== forgetting.subject ||
                workspaceId === undefined ||
                !forgetting.reachableWorkspaceIds.has(workspaceId)));
          if (!affected || forgetting.kind === 'item') return;
          stop();
          created.snapshot = {
            status: 'offline',
            doc: null,
            notice: 'This source note is no longer available.',
          };
          for (const listener of created.listeners) listener();
        });
        release = () => {
          if (stopped || created.listeners.size > 0 || confirming) return;
          if (revision === confirmedRevision) {
            stop();
            return;
          }
          // Collapsing hides the editor, but its document still holds unsaved edits.
          // Release only after Core-backed persistence confirms the final local revision.
          if (created.snapshot.status !== 'live' || sync === undefined) return;
          confirming = true;
          const savingRevision = revision;
          void sync.flushAndWait().then(
            () => {
              confirming = false;
              if (stopped) return;
              confirmedRevision = savingRevision;
              release();
            },
            () => {
              confirming = false;
              if (stopped) return;
              retry = setTimeout(() => {
                retry = null;
                release();
              }, 5_000);
            },
          );
        };
        if (scope === undefined) {
          connect(undefined);
        } else {
          void client
            .query(locks.getItemLock(targetId), { signal: controller.signal, forceRefresh: true })
            .then(async (lock) => {
              if (lock.locked && subject !== undefined && workspaceId !== undefined)
                await sealItemBodies(subject, workspaceId, targetId);
              connect(!lock.locked ? scope : undefined);
            })
            .catch(async (cause: unknown) => {
              if (stopped) return;
              if (
                isNixApiError(cause) &&
                (cause.status === 403 || cause.status === 404 || cause.status === 423)
              )
                await discardBodyCache(scope);
              created.snapshot = {
                status: 'offline',
                doc: null,
                notice: 'This source note could not be loaded.',
              };
              publish();
            });
        }
      },
      release: () => {
        release();
      },
      stop: () => {
        stop();
      },
    };
    entries?.set(entryKey, created);
    return created;
  }, [client, entries, getAccessToken, refreshReference, subject, targetId, workspaceId]);
  // Subscription identity is required by useSyncExternalStore to avoid reconnecting on every update.
  const subscribe = useCallback(
    (listener: () => void) => {
      entry.listeners.add(listener);
      if (entry.listeners.size === 1) entry.start();
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) entry.release();
      };
    },
    [entry],
  );
  return useSyncExternalStore(
    subscribe,
    () => entry.snapshot,
    () => unavailable,
  );
}

const previewExtensions = nixEditingExtensions.map((extension) => {
  if (extension.name === 'itemBlock')
    return extension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(ItemLinkView);
      },
    });
  if (extension.name === 'reference')
    return extension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(ReferenceView);
      },
    });
  if (extension.name === 'image')
    return extension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(NoteImageView);
      },
    });
  if (extension.name === 'pageBreak')
    return extension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(PageBreakView);
      },
    });
  const className = proseClasses[extension.name];
  return className === undefined
    ? extension
    : extension.configure({ HTMLAttributes: { class: className } });
});
function SourceEditor({
  doc,
  editable,
}: {
  readonly doc: Y.Doc;
  readonly editable: boolean;
}): ReactNode {
  const editor = useEditor(
    {
      extensions: [...previewExtensions, CollaborationHistoryKeymap],
      editable,
      editorProps: {
        attributes: {
          class: `${proseRoot} min-w-0 max-w-full break-words outline-none [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:max-w-full`,
          'aria-label': 'Embedded note content',
          role: 'textbox',
          'aria-multiline': 'true',
        },
      },
      onCreate: ({ editor: created }) => {
        created.registerPlugin(ySyncPlugin(doc.getXmlFragment(FRAGMENT_NAME)) as Plugin);
        created.registerPlugin(yUndoPlugin() as Plugin);
      },
    },
    [doc],
  );
  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);
  return (
    <ReferenceResolutionProvider>
      {!editable ? (
        <Text as="p" variant="caption" tone="muted">
          Read-only source
        </Text>
      ) : null}
      <EditorContent editor={editor} className="min-w-0 w-full max-w-full" />
    </ReferenceResolutionProvider>
  );
}
function SourcePreview({ targetId }: { readonly targetId: string }): ReactNode {
  const source = useSource(targetId);
  if (source.doc === null)
    return (
      <Text as="p" variant="note" role="status">
        {source.notice ??
          (source.status === 'connecting'
            ? 'Loading note…'
            : 'Source disconnected or unavailable. Reconnecting…')}
      </Text>
    );
  return (
    <div className="min-w-0 w-full max-w-full overflow-x-auto">
      {source.notice !== null ? (
        <Text as="p" variant="note" role="alert">
          {source.notice}
        </Text>
      ) : null}
      <SourceEditor doc={source.doc} editable={source.status === 'live'} />
    </div>
  );
}
export function ItemLinkView(props: ReactNodeViewProps): ReactNode {
  return <ItemBlockView {...props} nested />;
}
export function ItemBlockView(
  props: ReactNodeViewProps & { readonly nested?: boolean },
): ReactNode {
  const targetId = typeof props.node.attrs.targetId === 'string' ? props.node.attrs.targetId : null;
  const state = useReference(targetId);
  const refreshReference = useRefreshReference();
  useEffect(() => {
    if (targetId === null) return;
    const timer = setInterval(() => {
      refreshReference(targetId, false);
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [targetId, refreshReference]);
  const { select } = useSelectedItem();
  const [expanded, setExpanded] = useState(true);
  const embed =
    (props.node.attrs.presentation === 'embed' || props.node.attrs.presentation === 'subpage') &&
    !props.nested;
  return (
    <NodeViewWrapper
      contentEditable={false}
      className="my-4 min-w-0 w-full max-w-full rounded-md border border-divider p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="body" className="min-w-0 break-words">
          {state.status === 'resolved'
            ? (state.title ?? 'Untitled')
            : state.status === 'loading'
              ? 'Loading linked item…'
              : 'Linked item unavailable'}
        </Text>
        {embed && state.status === 'resolved' ? (
          <Button
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded(!expanded);
            }}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        ) : null}
        {state.status === 'resolved' && targetId !== null ? (
          <Button
            variant="ghost"
            onClick={() => {
              select(targetId);
            }}
          >
            {props.node.attrs.presentation === 'subpage' ? 'Open page' : 'Open source'}
          </Button>
        ) : null}
        {props.editor.isEditable ? (
          <Button
            variant="ghost"
            onClick={() => {
              props.deleteNode();
            }}
          >
            {embed ? 'Remove embed' : 'Remove link'}
          </Button>
        ) : null}
      </div>
      {embed &&
      expanded &&
      state.status === 'resolved' &&
      state.type === 'note' &&
      targetId !== null ? (
        <SourcePreview key={targetId} targetId={targetId} />
      ) : null}
      {embed &&
      expanded &&
      state.status === 'resolved' &&
      state.type === 'artifact' &&
      targetId !== null ? (
        // An embedded artifact runs live, with the artifact's own shared state.
        <Suspense fallback={<Text variant="note">Loading the artifact…</Text>}>
          <ArtifactView key={targetId} itemId={targetId} />
        </Suspense>
      ) : null}
    </NodeViewWrapper>
  );
}
export function PageBreakView(props: ReactNodeViewProps): ReactNode {
  const page = useEditorState({
    editor: props.editor,
    selector: ({ editor }) => {
      let number = 2;
      const position = props.getPos();
      if (position !== undefined)
        editor.state.doc.nodesBetween(0, position, (node) => {
          if (node.type.name === 'pageBreak') number += 1;
        });
      return number;
    },
  });
  return (
    <NodeViewWrapper
      contentEditable={false}
      className="my-6 flex flex-wrap items-center gap-2 border-y border-dashed border-divider py-3"
    >
      <Text variant="caption">Page break · Page {page}</Text>
      <Text variant="caption" tone="muted">
        Exported page numbers may differ as text flows onto additional pages.
      </Text>
      {props.editor.isEditable ? (
        <Button
          variant="ghost"
          onClick={() => {
            props.deleteNode();
          }}
        >
          Remove page break
        </Button>
      ) : null}
    </NodeViewWrapper>
  );
}
