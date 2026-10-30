import { noteColumn } from '@nix/web-foundation/layout/regions';
import { PaneViewport } from '@nix/web-foundation/layout/pane-viewport';
import type { DraftState } from '@nix/web-foundation/lib/draft-journal';
import { MobileNoteToolbar, type MobileNoteDetails } from './mobile-note-toolbar';
import { useDrawerNavigation } from '@nix/web-foundation/layout/viewport';
import { nixEditingExtensions, readWidth } from '@nix/editor-schema';
import {
  files as fileResources,
  items as coreItems,
  suggestions,
  type NixClient,
} from '@nix/api-client';
import { Icon, Text } from '@nix/ui';
import { mergeAttributes, type Editor } from '@tiptap/core';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { NodeRange } from '@tiptap/extension-node-range';
import { Dropcursor, Gapcursor } from '@tiptap/extensions';
import { Fragment, Slice } from '@tiptap/pm/model';
import { dropPoint } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { EditorContent, ReactNodeViewRenderer, useEditor, useEditorState } from '@tiptap/react';
import { GripVertical } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import { useParams } from 'react-router';
import { TextSelection, type Plugin, type Transaction } from '@tiptap/pm/state';
import { Awareness } from 'y-protocols/awareness';
import { redo, undo, yCursorPlugin, ySyncPluginKey, yUndoPlugin, ySyncPlugin } from 'y-prosemirror';
import * as Y from 'yjs';

import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useCurrentPrincipal } from '@nix/web-platform/session/use-current-principal';
import { ItemBlockView, PageBreakView, NoteSourcesProvider } from './note-block-views';
import { ItemInsertDialog, type ItemInsertKind } from './item-insert-dialog';
import { Button } from '@nix/ui';
import { ColumnControls } from './column-controls';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { BubbleMenu } from './bubble-menu';
import { CommentAnchors, captureAnchor, requestComment, useItemComments } from './comment-anchors';
import { useCommentSync } from './use-comment-sync';
import { CollaborationHistoryKeymap } from './collaboration-history-keymap';
import { EditorToolbar, SuggestingControl } from './toolbar';
import { Suggesting, hasSuggestions, setSuggesting } from './suggesting';
import { MARKDOWN_ORIGIN, snapshotMarkdown, type MarkdownSnapshot } from './markdown-mode';
import { MarkdownLossesDialog, MarkdownModePanel } from './markdown-mode-panel';
import { announce } from '@nix/web-foundation/a11y/announcer';
import { playRecordingFrom } from '@nix/web-foundation/audio/play-from';
import { parseAudioTimestamp } from '@nix/web-foundation/lib/audio-timestamp-link';
import { EditorAddressDialog, type EditorAddressKind } from './editor-address-dialog';
import { EmacsKeymap, emacsStatus } from './emacs-keymap';
import { GhostText, setGhostTextContext } from './ghost-text';
import { useGhostTextPreference } from './ghost-text-preference';
import { warmPhraseLibrary } from './phrase-library';
import { MentionBubble } from './mention-bubble';
import { useMentionPreference } from './mention-preference';
import { setMentionContext, UnlinkedMentions } from './unlinked-mentions';
import { MoveBlock } from './move-block';
import { useKeyboardModeStore } from './keyboard-mode-store';
import { documentScope } from '@nix/web-foundation/lib/body-cache';
import { FRAGMENT_NAME, startCollabSync, type CollabSync, type SyncState } from './collab-sync';
import { PresenceList } from './presence-list';
import { remoteCursor } from './remote-cursor';
import { DocumentIssueDialog, LOCAL_COPY_STALE } from './document-issue-dialog';
import { usePageGuidePreference } from './page-guide-preference';
import { PageGuides } from './page-guides-overlay';
import { calloutClass, headingClass, proseClasses, proseRoot } from './prose';
import { TableControls } from './table-controls';
import { ColumnWidthControls } from './column-width';
import { TableMenu } from './table-menu';
import { ReferenceMenu } from './reference-menu';
import { ReferenceResolutionProvider } from './reference-resolution';
import { ReferenceView } from './reference-view';
import { NoteImageView } from './note-image-view';
import { SlashMenu } from './slash-menu';
import { InlineAiPanel } from './inline-ai/inline-ai-panel';
import { useInlineAi } from './inline-ai/use-inline-ai';
import { renderToggleButton, toggleSummaryView } from './toggle-button';
import { setVimEnabled, vimModeLabel, vimStatus, VimMotions } from './vim-motions';
import { isImageFile, mediaTypeForFile } from '@nix/web-foundation/lib/file-kind';
import { MermaidCodeBlockView } from '../plugins/mermaid-code-block-view';
import {
  MermaidCaptureContext,
  storeCapture,
  type MermaidCaptureUpload,
} from '../plugins/mermaid-capture';
import { PendingReferenceNotice } from './pending-reference-notice';
import { usePendingDailyTemplate } from './use-pending-daily-template';
import {
  setEditorWritingMode,
  useWritingModePreference,
  WritingModeKeymap,
  WRITING_MODES,
} from './writing-mode';
import { WritingModeControl } from './writing-mode-control';
import { TextWidthControl } from './text-width-control';
import { NoteStatsFooter } from './note-stats';
import { useTextWidthPreference } from './text-width-preference';

/**
 * The note body: a TipTap editor over a Yjs document, synchronised through the collaboration
 * service.
 *
 * **Undo is the Yjs-aware history, not ProseMirror's.** With a shared document, ProseMirror's
 * default history would undo whatever happened last - including a colleague's edit - which is the
 * single most alarming thing a collaborative editor can do. `yUndoPlugin` undoes only your own.
 *
 * **The document is the schema package's**, not this file's. The collaboration service validates
 * every accepted update against the same definition, so a block that renders here is a block that
 * stores, and there is no way for the two to disagree.
 *
 * The editor is keyed on the item by its caller, so switching notes builds a new Yjs document
 * rather than reusing one - the failure that would otherwise carry one note's text into another.
 */

export interface NoteEditorProps {
  readonly itemId: string;
  readonly mobileActions?: ReactNode;
  /** The details panel's toggle, docked with the writing tools on a phone. */
  readonly mobileDetails?: MobileNoteDetails | undefined;
  readonly documentPath?: string | undefined;
  readonly onSync?: ((sync: CollabSync | null) => void) | undefined;
  /**
   * Keep a local copy of this body so reopening it paints at once (see `body-cache.ts`). Off
   * unless the page says so: only a page that has read the item's lock state knows the body
   * carries no lock, and a locked body is never kept on disk.
   */
  readonly cacheBody?: boolean;
  /** Hide the formatting chrome while retaining the mounted collaborative editor. */
  readonly hideToolbar?: boolean;
  /**
   * The note's parent as the page already knows it (`null` at a workspace root, `undefined` when
   * the page does not know). A ranking hint for the reference picker only, so a stale value after a
   * move costs nothing but a slightly different order.
   */
  readonly parentId?: string | null | undefined;
}

/**
 * The schema's extensions, each carrying the class its nodes render with.
 *
 * **Why the classes are attached here rather than in the schema package.** The collaboration
 * service builds the same schema in Node to check that an accepted update still parses, and it has
 * no business knowing what a blockquote looks like. Keeping presentation on this side is what lets
 * one definition of the document serve both, which is the whole reason that package exists.
 *
 * **Why per-extension configuration rather than a stylesheet.** ProseMirror renders the document
 * itself, so React never sees the nodes and cannot put a className on them - and the repository
 * permits no stylesheet to hang selectors off. TipTap's own `HTMLAttributes` is the seam that
 * remains, and it is the supported one.
 *
 * Heading and callout are configured through `renderHTML` instead, because their class depends on
 * an attribute - the level, the tone - which a fixed string cannot express.
 */
/**
 * What TipTap hands a node's renderer.
 *
 * Named here because `extend` widens its argument to `any`, and the two renderers below read an
 * attribute off the node - which is exactly the place an untyped argument would let a typo through
 * silently.
 */
interface RenderArgs {
  // Narrowed to the attributes these renderers read, rather than an open bag: a typo in an
  // attribute name is otherwise an `unknown` that stringifies to "[object Object]" in a class name
  // and produces an element styled as nothing at all.
  readonly node: {
    readonly attrs: {
      readonly level?: unknown;
      readonly tone?: unknown;
      readonly width?: unknown;
    };
  };
  readonly HTMLAttributes: Record<string, unknown>;
}

/**
 * `nixEditingExtensions`, not `nixExtensions`: the schema *and* the column editing behaviour it
 * needs to stay in a shape the product can draw (ADR-0032). Mapping over the pairing rather than
 * bolting `ColumnEditing` on afterwards is what makes the pairing load-bearing here and not only
 * in the tests - and it costs nothing, because an extension with no `proseClasses` entry falls
 * through the last branch of this map untouched.
 */
const styledExtensions = nixEditingExtensions.map((extension) => {
  if (extension.name === 'heading') {
    return extension.extend({
      renderHTML({ node, HTMLAttributes }: RenderArgs) {
        const level = Number(node.attrs.level ?? 1);
        return [
          `h${String(level === 2 || level === 3 ? level : 1)}`,
          mergeAttributes(HTMLAttributes, { class: headingClass(level) }),
          0,
        ];
      },
    });
  }

  if (extension.name === 'callout') {
    return extension.extend({
      renderHTML({ node, HTMLAttributes }: RenderArgs) {
        const tone = typeof node.attrs.tone === 'string' ? node.attrs.tone : 'note';
        return [
          'aside',
          mergeAttributes(HTMLAttributes, { 'data-callout': '', class: calloutClass(tone) }),
          0,
        ];
      },
    });
  }

  if (extension.name === 'details') {
    return extension.configure({
      HTMLAttributes: { class: proseClasses.details },

      /**
       * The disclosure control - see `toggle-button.ts` for what it fixes and how a keyboard
       * reaches it. Configured here rather than in `@nix/editor-schema` for the same reason
       * every class is: the collaboration service builds the same node list in Node and has
       * no icon library, no DOM and no business knowing what a chevron looks like.
       */
      renderToggleButton,
    });
  }

  if (extension.name === 'detailsSummary') {
    return extension.extend({
      /**
       * A summary that is honestly a heading when its toggle is one - see `toggle-button.ts`.
       * A node view rather than `renderHTML`, because the level lives on the parent details
       * node, which `renderHTML` cannot see.
       */
      addNodeView() {
        return toggleSummaryView;
      },
    });
  }

  if (extension.name === 'reference') {
    return extension.extend({
      /**
       * Drawn by React, because what it says depends on an answer from the server.
       *
       * The schema's own `renderHTML` puts the stored label on the page, which is right for the
       * collaboration service and for an export - neither can ask anybody anything. In the editor
       * it is only ever a stand-in: the title may have changed since the link was made, and the
       * reader may not be entitled to it at all. Both are questions only a component that can
       * fetch is able to answer, so the node gets a view rather than a class.
       */
      addNodeView() {
        return ReactNodeViewRenderer(ReferenceView);
      },
    });
  }

  if (extension.name === 'itemBlock')
    return extension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(ItemBlockView);
      },
    });
  if (extension.name === 'pageBreak')
    return extension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(PageBreakView);
      },
    });

  if (extension.name === 'image') {
    return extension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(NoteImageView);
      },
    });
  }

  if (extension.name === 'codeBlock')
    return extension.extend({
      addNodeView() {
        return ReactNodeViewRenderer(MermaidCodeBlockView);
      },
    });

  if (extension.name === 'columnEditing') {
    return extension.configure({
      /**
       * How the repair tells a colleague's change from this client's own.
       *
       * The schema package defaults to matching y-prosemirror's meta *by its key string*,
       * because it must not depend on the CRDT binding - and that default fails silently if the
       * string ever changes: every remote change would read as local, every open client would
       * repair the same merge, and an empty column would collect one inserted paragraph per
       * client. This file owns the dependency, so it hands over the key itself and the coupling
       * becomes a reference a rename cannot survive quietly.
       */
      isRemote: (transaction: Transaction) => transaction.getMeta(ySyncPluginKey) !== undefined,
    });
  }

  if (extension.name === 'column') {
    return extension.extend({
      renderHTML({ node, HTMLAttributes }: RenderArgs) {
        // A width is a fraction of the row, so it becomes `flex-grow` - which no utility class
        // can express, because the set of fractions is not finite. `basis-0` and `flex-1` in
        // `proseRoot` are what make an unstated width an equal share; this only has to override
        // the grow factor when a column actually carries one.
        //
        // Written here rather than in `@nix/editor-schema` for the same reason every other
        // class is: the collaboration service builds the same node list in Node to check that
        // an update still parses, and it has no business knowing how wide a column looks.
        // Read through the schema's own `readWidth`, which is the point of that function being
        // exported. A local `Number(...)` here was not the same predicate: it *coerces*, so a
        // document whose JSON carries a string width rendered at that width while every command
        // and every divider read it as an equal share - a 3:1 split whose handle announced 50%.
        const width = readWidth(node.attrs.width);
        const style = width === null ? {} : { style: `flex-grow: ${String(width)}` }; // design-token-exempt: a column's share of its row is a runtime fraction, not a scale step - the same case as the sheet grid's column offsets.

        return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '' }, style), 0];
      },
    });
  }

  const className = proseClasses[extension.name];
  return className === undefined
    ? extension
    : extension.configure({ HTMLAttributes: { class: className } });
});

/**
 * Cursor colors, from the accent ramp and nothing else - but resolved to their values at
 * runtime, because y-prosemirror's cursor renderer accepts only literal six-digit colors
 * and cannot dereference a CSS variable.
 */
const CURSOR_COLOR_TOKENS = [
  '--color-accent-600',
  '--color-accent-2',
  '--color-accent-400',
  '--color-accent-700',
] as const;

function cursorColorFor(clientId: number): string {
  const token = CURSOR_COLOR_TOKENS[clientId % CURSOR_COLOR_TOKENS.length] ?? '--color-accent';
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return resolved.length > 0 ? resolved : '#5980a6'; // design-token-exempt: the accent token's own value, used only where no stylesheet is loaded at all (tests); the resolved token wins everywhere real.
}

/**
 * What the collaboration service can refuse, said in words a writer can act on.
 *
 * **Every one of these means the edit is not saved and no colleague will see it.** Without
 * this, the refusal is silent: the text stays on screen because the local CRDT accepted it,
 * the editor looks healthy, and the work is gone on reload. That failure is the reason
 * ADR-0024 made a client-visible story a precondition for the version-2 schema shipping.
 *
 * A code with no entry is deliberately not shown. These are the ones a person can do something
 * about; a transport hiccup that the reconnect already handles is noise.
 */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  document_above_schema_pin:
    'This note has not finished upgrading, so blocks added in this version cannot be saved to ' +
    'it yet. Everything else saves normally. Try again shortly.',
  schema_version_mismatch:
    'This note was written by a newer version of Nix than this one. Reload the page to catch up.',
  document_does_not_parse:
    'That change could not be saved: it would leave the note in a state Nix cannot reopen.',
  document_too_many_nodes:
    'This note has reached its size limit. Remove something before adding more.',
  document_too_large: 'This note has reached its size limit. Remove something before adding more.',
  // Deliberately not "pausing for a moment", which this said first: nothing pauses and nothing
  // resumes on its own. The update was refused, and what recovers it is the resync the server
  // sends immediately afterwards - so the honest thing is to name the delay, not promise a pause.
  rate_limited: 'That last change is taking a moment to save. It has not been lost.',
  read_only: 'You have read access to this note, so your changes are not being saved.',
  editing_elsewhere: 'Someone else is editing this note. You can edit when they leave.',
  access_revoked: 'Access to this note was revoked. Recent changes cannot be saved.',
  local_draft_unreadable:
    'A saved draft could not be recovered. Keep this device’s data until the draft is recovered.',
};

/**
 * The origin for transactions that keep the document above the schema's floor.
 *
 * A symbol rather than an object, for the same reasons collab-sync's `REMOTE_ORIGIN` is one:
 * origins are compared by identity, a symbol names itself in a log, and Yjs's undo manager
 * falls back to matching `origin.constructor` - so a bare `{}` would start being tracked the
 * moment any tracked set gained `Object`. Its own origin, and not the sync plugin's, because
 * the undo manager tracks that plugin's origin: a restoration folded into the history being
 * unwound would be removed by the very next undo.
 */
const RESTORE_ORIGIN = Symbol('nix.editor.restore');

/**
 * A completed upload is an item immediately, even before its reference reaches the document. If
 * the editor disappears or cannot accept the node after completion, soft-delete that unattached
 * item so its bytes remain covered by the normal object cleanup path instead of becoming an
 * orphan. This deliberately has no operation signal: unmount cancellation is the reason this
 * cleanup is needed and must not cancel the cleanup itself.
 */
async function discardUnattachedFile(
  client: NixClient,
  workspaceId: string,
  itemId: string,
): Promise<void> {
  try {
    await client.execute(coreItems.deleteItem(workspaceId, itemId));
  } catch (cause) {
    console.warn('A completed but unattached file could not be discarded.', cause);
  }
}

function describeEditorWith(element: HTMLElement, id: string, enabled: boolean): void {
  const ids = (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((candidate) => candidate.length > 0 && candidate !== id);
  if (enabled) {
    ids.push(id);
  }
  if (ids.length === 0) {
    element.removeAttribute('aria-describedby');
  } else {
    element.setAttribute('aria-describedby', ids.join(' '));
  }
}

/** Frames to wait for a closing modal to unmount, about two seconds at 60Hz. */
const DIALOG_CLOSE_FRAMES = 120;

/** Uploads must recheck the current access mode after their asynchronous work. */
function viewAcceptsEdits(view: EditorView): boolean {
  return view.editable;
}

function focusAfterDialog(editor: Editor): void {
  // A modal makes the editor inert, and Dialog hands focus back to its invoker - the toolbar
  // button - in the cleanup that runs when React unmounts it. Editor focus has to come after that,
  // or the caret is left stranded on the button. A fixed two frames used to stand in for "after":
  // on a loaded machine React can commit the close later than that, the invoker then wins, and the
  // editor never gets focus. So wait until no modal is open, then focus on the frame after - the
  // unmount and its cleanup happen in one commit, so that frame is after the hand-back. The wait is
  // bounded so an unrelated modal left open cannot keep this looping.
  let frames = 0;
  const attempt = (): void => {
    if (editor.isDestroyed) return;
    if (document.querySelector('dialog[open]') !== null && frames < DIALOG_CLOSE_FRAMES) {
      frames += 1;
      requestAnimationFrame(attempt);
      return;
    }
    requestAnimationFrame(() => {
      if (!editor.isDestroyed) {
        editor.view.focus();
      }
    });
  };
  requestAnimationFrame(attempt);
}

export function NoteEditor({
  itemId,
  documentPath,
  onSync,
  mobileActions,
  mobileDetails,
  cacheBody = false,
  hideToolbar = false,
  parentId,
}: NoteEditorProps): ReactNode {
  const narrow = useDrawerNavigation();
  const { getAccessToken } = useAuth();
  const client = useApiClient();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const profile = useSessionStore((state) => state.profile);
  const subject = profile?.subject;
  // Suggestions are stamped with the workspace principal id (what names resolve from), not the
  // OIDC subject; the subject only stands in if /me fails. Off while /me loads: no mixed stamps.
  const me = useCurrentPrincipal();
  const suggestAs = me.status === 'loading' ? '' : (me.principal?.id ?? subject ?? '');
  const [draftState, setDraftState] = useState<DraftState | undefined>();
  const [syncState, setSyncState] = useState<SyncState>('connecting');
  const [readOnly, setReadOnly] = useState(false);
  // Markdown editing (requirement 8): `confirming` holds the snapshot while the losses dialog is
  // up; `open` holds it while the textarea is. Taken once, when the person asks, so the dialog and
  // the text agree. Never persisted: a mode is a way of looking at this session's note.
  const [markdownMode, setMarkdownMode] = useState<
    | { readonly phase: 'confirming'; readonly snapshot: MarkdownSnapshot }
    | { readonly phase: 'open'; readonly snapshot: MarkdownSnapshot }
    | null
  >(null);
  // Whether the server's copy of the body has arrived at least once; see `onInitialSync`.
  const [synced, setSynced] = useState(false);

  // What the server last refused, in words. Held rather than derived because a refusal is an
  // event: the document on screen still shows the edit, and the only honest thing to do is say
  // it did not stick.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [noticeCode, setNoticeCode] = useState<string | null>(null);
  const bodyUnavailable =
    noticeCode === 'body_access_unavailable' || noticeCode === 'access_revoked';
  // A stale local copy must remain read-only until the current version is loaded.
  const [stale, setStale] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(0);
  const [uploadingFileIndex, setUploadingFileIndex] = useState(0);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);
  const uploadingFilesRef = useRef(0);
  const dropAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [itemRequest, setItemRequest] = useState<ItemInsertKind | null>(null);
  const insertionRef = useRef<number | null>(null);
  const [retryFiles, setRetryFiles] = useState<readonly File[]>([]);
  const [addressRequest, setAddressRequest] = useState<EditorAddressKind | null>(null);
  const keyboardMode = useKeyboardModeStore((state) => state.mode);
  const writingMode = useWritingModePreference((state) => state.mode);
  const textWidth = useTextWidthPreference((state) => state.width);
  const vimDescriptionId = useId();
  const ghostSetting = useGhostTextPreference((state) => state.setting);
  const mentionSetting = useMentionPreference((state) => state.setting);

  // One document per item, created exactly once via useState's lazy initializer - unlike
  // useMemo, which is only a performance hint React is free to discard and recompute,
  // useState's initial value truly runs once per mount. Rebuilding the document on a render
  // would discard everything typed since the last one.
  const [doc] = useState(() => new Y.Doc());
  const fragment = useMemo(() => doc.getXmlFragment(FRAGMENT_NAME), [doc]);

  // Presence lives with the document, not the connection: the cursor plugin needs it at
  // plugin-registration time, before any socket exists, and it survives reconnects. Same
  // reasoning as `doc` above: constructed with useState so it is guaranteed to happen once.
  const [awareness] = useState(() => new Awareness(doc));

  // Mermaid capture uploads only from a live, synced, writable session (ADR-0063).
  const captureDiagram = useMemo<MermaidCaptureUpload | null>(() => {
    if (readOnly || stale || !synced || workspaceId === undefined) return null;
    return (svg, renderFileId) =>
      storeCapture(client, { workspaceId, pageItemId: itemId, svg, renderFileId });
  }, [client, itemId, readOnly, stale, synced, workspaceId]);

  const uploadDroppedFiles = useCallback(
    async (
      view: EditorView,
      files: readonly File[],
      position: number,
      description?: string,
      reportError = true,
    ): Promise<boolean> => {
      if (!view.editable) {
        if (reportError) setRefusal('This note is read-only. The file cannot be added.');
        else throw new Error('This note is read-only. The file cannot be added.');
        return false;
      }
      if (workspaceId === undefined) {
        if (reportError) setRefusal('The current workspace is unavailable.');
        else throw new Error('The current workspace is unavailable.');
        return false;
      }
      if (uploadingFilesRef.current > 0) {
        if (!reportError)
          throw new Error(
            'A file upload is already in progress. Wait for it to finish before adding more.',
          );
        setRefusal(
          'A file upload is already in progress. Wait for it to finish before adding more.',
        );
        return false;
      }
      setRefusal(null);
      uploadingFilesRef.current = files.length;
      setUploadingFiles(files.length);
      setUploadingFileIndex(0);
      setUploadingFileName(null);
      const controller = new AbortController();
      dropAbortRef.current?.abort();
      dropAbortRef.current = controller;
      insertionRef.current = position;
      let activeFileName: string | null = null;
      let unattachedItemId: string | null = null;
      try {
        for (const [index, file] of files.entries()) {
          setRetryFiles(files.slice(index));
          activeFileName = file.name;
          setUploadingFileIndex(index + 1);
          setUploadingFileName(file.name);
          const upload = await client.execute(
            fileResources.beginUpload({
              workspaceId,
              parentId: itemId,
              fileName: file.name,
              mediaType: mediaTypeForFile(file),
              byteLength: file.size,
              idempotencyKey: `web-note-drop:${crypto.randomUUID()}`,
            }),
            { signal: controller.signal },
          );
          const uploaded = await fileResources.uploadAndCompleteFile(
            client,
            upload,
            file,
            controller.signal,
          );
          unattachedItemId = uploaded.itemId;
          if (controller.signal.aborted || !mountedRef.current || view.isDestroyed) {
            await discardUnattachedFile(client, workspaceId, unattachedItemId);
            unattachedItemId = null;
            return false;
          }
          const node =
            isImageFile(file) && uploaded.current.previewable
              ? view.state.schema.nodes.image?.create({
                  src: '',
                  alt: description ?? file.name,
                  fileItemId: uploaded.itemId,
                })
              : view.state.schema.nodes.itemBlock?.create({
                  presentation: 'attachment',
                  kind: 'item',
                  targetId: uploaded.itemId,
                  label: file.name,
                });
          if (node === undefined) {
            throw new Error('This note cannot contain the uploaded file.');
          }
          const currentPosition = Math.min(insertionRef.current, view.state.doc.content.size);
          const target = dropPoint(
            view.state.doc,
            currentPosition,
            new Slice(Fragment.from(node), 0, 0),
          );
          if (target === null) {
            throw new Error('The file could not be placed at that location.');
          }
          if (!viewAcceptsEdits(view))
            throw new Error('This note is read-only. The file cannot be added.');
          const transaction = view.state.tr.insert(target, node);
          const afterNode = target + node.nodeSize;
          if (transaction.doc.nodeAt(afterNode)?.type.name !== 'paragraph') {
            const paragraph = view.state.schema.nodes.paragraph?.create();
            if (paragraph !== undefined) transaction.insert(afterNode, paragraph);
          }
          const caret = Math.min(afterNode + 1, transaction.doc.content.size);
          transaction.setSelection(TextSelection.near(transaction.doc.resolve(caret)));
          view.dispatch(transaction.scrollIntoView());
          insertionRef.current = caret;
          unattachedItemId = null;
          setRetryFiles(files.slice(index + 1));
        }
        view.focus();
        return true;
      } catch (cause) {
        if (unattachedItemId !== null) {
          await discardUnattachedFile(client, workspaceId, unattachedItemId);
          unattachedItemId = null;
        }
        if (!controller.signal.aborted && reportError) {
          const message =
            cause instanceof Error ? cause.message : 'The file could not be uploaded.';
          setRefusal(
            activeFileName === null ? message : `Could not add ${activeFileName}: ${message}`,
          );
        }
        if (!reportError && !controller.signal.aborted) throw cause;
        return false;
      } finally {
        if (dropAbortRef.current === controller) dropAbortRef.current = null;
        uploadingFilesRef.current = 0;
        setUploadingFiles(0);
        setUploadingFileIndex(0);
        setUploadingFileName(null);
      }
    },
    [client, itemId, workspaceId],
  );

  const handleFileDrop = useCallback(
    (view: EditorView, event: DragEvent): boolean => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return false;
      let position = view.state.selection.from;
      try {
        const coordinates = view.posAtCoords({ left: event.clientX, top: event.clientY });
        position = coordinates?.pos ?? position;
      } catch {
        // A dropped file still belongs in the current selection if its screen point cannot be
        // mapped while the editor is reflowing.
      }
      event.preventDefault();
      void uploadDroppedFiles(view, files, position);
      return true;
    },
    [uploadDroppedFiles],
  );

  const hasFilePayload = (event: ReactDragEvent): boolean =>
    event.dataTransfer.types.includes('Files') || event.dataTransfer.files.length > 0;

  const editor = useEditor({
    extensions: [
      ...styledExtensions,

      // Editing behaviour, added here rather than in the schema package: the collaboration
      // service builds the same schema in Node and has no use for a gap cursor.
      Gapcursor,
      Dropcursor,
      // The platform history keys must reach the same client-local Yjs history as the toolbar.
      // ProseMirror history is intentionally not installed in a collaborative document.
      CollaborationHistoryKeymap,
      // A live browser-local preference. The extension stays installed so changing the preset
      // never rebuilds this editor or its Yjs binding.
      EmacsKeymap,
      VimMotions,
      WritingModeKeymap,
      // Phrase suggestions as muted text at the caret; a decoration, never document content.
      // Told what it needs (the preference, the scope) by an effect below, through its storage,
      // so changing the preference never rebuilds this editor or its Yjs binding.
      GhostText,
      // Item titles written but not linked, underlined; decorations again, told what they need
      // by an effect below.
      UnlinkedMentions,
      // Mod-Shift-ArrowUp/Down: the keyboard's way to reorder a block, beside the pointer-only
      // drag handle below.
      MoveBlock,
      // Lets the drag handle select and move a whole block as a node range rather than a text
      // span - without it, grabbing a block would drag whatever text selection happened to
      // exist. The handle itself is the <DragHandle> component below, which registers its own
      // plugin against this editor.
      NodeRange,

      // What columns need from a browser: the names a screen reader hears, the resize
      // handles, the drop targeting, and the keys that give every gesture a keyboard. The
      // commands and the repair came in through `styledExtensions` above.
      ColumnControls,

      // Where you are in a table, drawn: the current row, column and cell get a wash so the
      // table menu's "delete row" is a thing a person can see the target of.
      TableControls,
      // "Narrower"/"Wider"/"Reset" in the table menu and the compact toolbar's table group -
      // the same `colwidth` change the resize handle makes, run without a drag.
      ColumnWidthControls,
      // Track changes: edits become suggestions while the toolbar's switch is on. Told who and
      // whether by an effect below, through its storage.
      Suggesting,
      // Comment threads drawn on the text they were made on; told which note it is by
      // `useCommentSync` below.
      CommentAnchors,
    ],

    // No `content`: the Yjs document is the source of truth, and seeding content here would
    // insert it again on every client that opened the note.
    onTransaction: ({ transaction }) => {
      if (insertionRef.current !== null)
        insertionRef.current = transaction.mapping.map(insertionRef.current);
    },
    editorProps: {
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(isImageFile);
        if (files.length === 0) return false;
        void uploadDroppedFiles(view, files, view.state.selection.from);
        return true;
      },
      // A transcript's timestamp is a link to its recording at a moment (see
      // `lib/audio-timestamp-link.ts`). Links here do not open on a plain click, but this one
      // has an answer that is not navigation: play the recording from that line.
      handleClick: (view, position, event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return false;
        const link = view.state.doc
          .resolve(position)
          .marks()
          .find((mark) => mark.type.name === 'link');
        const href: unknown = link?.attrs.href;
        const timestamp =
          typeof href === 'string' ? parseAudioTimestamp(href, window.location.origin) : null;
        if (timestamp === null) return false;
        void playRecordingFrom(client, timestamp.itemId, timestamp.seconds).catch(() => {
          announce('That recording could not be played.');
        });
        return true;
      },
      attributes: {
        class: `${proseRoot} min-h-full outline-none`,
        'data-writing-mode': writingMode,
        'aria-label': 'Note body',
        role: 'textbox',
        'aria-multiline': 'true',
      },
    },

    onCreate: ({ editor: created }) => {
      created.registerPlugin(ySyncPlugin(fragment) as Plugin);
      created.registerPlugin(yCursorPlugin(awareness, { cursorBuilder: remoteCursor }) as Plugin);
      // The Markdown mode's whole-body swap is tracked too, so Ctrl+Z after applying restores
      // the rich note in one step (the floor guard's RESTORE_ORIGIN stays untracked, as before).
      created.registerPlugin(yUndoPlugin({ trackedOrigins: [MARKDOWN_ORIGIN] }) as Plugin);
    },
  });

  useCommentSync(editor, itemId, synced && !stale);

  const pageGuides = usePageGuidePreference((state) => state.visibility);
  // State rather than a ref, so the overlay renders once the box exists rather than one render late.
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const inlineAi = useInlineAi({ editor, itemId, workspaceId });

  const activeVim = useEditorState({
    editor,
    selector: ({ editor: current }) => vimStatus(current.state),
  });
  const activeEmacs = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      keyboardMode === 'emacs' ? emacsStatus(current.state) : null,
  });
  // One status line for whichever keyboard preset is on: its mode, recording, feedback and keys.
  const presetStatus =
    activeVim !== null
      ? {
          label: `Vim ${vimModeLabel(activeVim.mode)}`,
          recording: activeVim.recording === null ? null : `recording @${activeVim.recording}`,
          message: activeVim.message,
          keys: activeVim.keys,
        }
      : activeEmacs !== null
        ? {
            label: 'Emacs',
            recording: activeEmacs.recording ? 'defining macro' : null,
            message: activeEmacs.message,
            keys: activeEmacs.keys,
          }
        : null;

  useEffect(() => {
    setEditorWritingMode(editor, writingMode);
  }, [editor, writingMode]);

  const [suggesting, setSuggestingOn] = useState(false);
  const suggestingKey = `nix.suggesting.${itemId}`;
  // Per viewer and per note, kept on this device only; applied once the note can be edited.
  useEffect(() => {
    if (readOnly || stale) return;
    try {
      if (localStorage.getItem(suggestingKey) === '1') setSuggestingOn(true);
    } catch {
      // Storage can be blocked; suggesting then starts off each time.
    }
  }, [suggestingKey, readOnly, stale]);
  const { canComment } = useItemComments(itemId);
  const suggestionsPending = useEditorState({
    editor,
    selector: ({ editor: current }) => hasSuggestions(current.state.doc),
  });
  useEffect(() => {
    setSuggesting(editor, { enabled: suggesting && !readOnly && !stale, authorId: suggestAs });
  }, [editor, readOnly, stale, suggestAs, suggesting]);

  // The server's read-only mode and stale copies cannot save edits.
  useLayoutEffect(() => {
    editor.setEditable(!readOnly && !stale);
  }, [editor, stale, readOnly]);

  // A daily note's template goes in once the server's copy is known to be empty.
  usePendingDailyTemplate({
    itemId,
    editor,
    fragment,
    synced,
    writable: !readOnly && !stale,
  });

  // The mention underlines' view of this note. The lookup goes through the client like every
  // other request; read-only is checked where it is called.
  useEffect(() => {
    setMentionContext(editor, {
      enabled: mentionSetting === 'on' && !stale,
      workspaceId,
      currentItemId: itemId,
      find:
        workspaceId === undefined
          ? undefined
          : (lookup, signal) =>
              client.execute(
                suggestions.findMentions({
                  text: lookup.text,
                  workspaceId,
                  excludeIds: lookup.excludeIds,
                }),
                { signal },
              ),
    });
  }, [client, editor, itemId, mentionSetting, stale, workspaceId]);

  // The phrase suggestions' view of this note. `learnable` is the body cache's own permission:
  // only a body the page may keep a local copy of may be learned into the session library.
  useEffect(() => {
    const scope = documentScope(subject, workspaceId, itemId, documentPath ?? 'note');
    setGhostTextContext(editor, {
      enabled: ghostSetting === 'on' && !stale,
      subject,
      workspaceId,
      scope,
      learnable: cacheBody && scope !== undefined,
    });
    if (ghostSetting !== 'on' || subject === undefined || workspaceId === undefined) {
      return;
    }
    // On idle, learn the notes this browser already keeps copies of in this workspace.
    const controller = new AbortController();
    warmPhraseLibrary(subject, workspaceId, scope, controller.signal);
    return () => {
      controller.abort();
    };
  }, [cacheBody, documentPath, editor, ghostSetting, itemId, subject, stale, workspaceId]);

  useEffect(() => {
    let described: HTMLElement | null = null;
    const applyMode = (): void => {
      if (editor.isDestroyed) return;
      const view = editor.view;
      setVimEnabled(view, keyboardMode === 'vim');
      if (described !== null && described !== view.dom)
        describeEditorWith(described, vimDescriptionId, false);
      described = view.dom;
      describeEditorWith(described, vimDescriptionId, keyboardMode === 'vim');
    };
    editor.on('mount', applyMode);
    editor.on('create', applyMode);
    if (editor.isInitialized) applyMode();
    return () => {
      editor.off('mount', applyMode);
      editor.off('create', applyMode);
      if (described !== null) describeEditorWith(described, vimDescriptionId, false);
    };
  }, [editor, keyboardMode, vimDescriptionId]);

  // The one document shape the schema refuses outright is an empty one - `doc` is `block+` -
  // and the Yjs undo manager can produce it. ProseMirror editing cannot: deleting everything
  // leaves one empty paragraph, because the schema's floor is enforced on every transaction.
  // But undo unwinds the *Yjs* history, below that floor, so undoing every edit you made on a
  // note you wrote returns the fragment to its pre-content state with no children at all.
  //
  // The sync binding does heal an emptied fragment, but a render cycle later - and what makes
  // that gap fatal is that collab-sync defers every send behind its flush timer, so a timer
  // firing (or a teardown flush) inside the gap sends the emptying update to the server alone.
  // The service refuses it as a document it could never reopen and forces a resync, which on
  // screen reads as an undo that silently did not take. Restoring the floor *synchronously*,
  // in the same transaction-cleanup pass, is what guarantees the restoration shares a flush
  // with the emptying: no send boundary can fall between two updates queued in one tick.
  //
  // Teardown needs no ordering care, and here is why, so nobody has to re-derive it: the
  // restoration is synchronous with the emptying, so by the time any unmount cleanup runs -
  // this observer detaching, or `sync.destroy()` flushing what is still pending - an emptying
  // that happened has already been answered, and the final flush carries both or neither.
  useEffect(() => {
    // The last paragraph this guard inserted, while it remains an empty placeholder. Held so
    // that when real content comes back - a redo restoring what the undo removed - the
    // placeholder does not linger as a blank block nobody authored and, being untracked by the
    // undo manager, no undo could ever remove.
    let restored: Y.XmlElement | null = null;

    const keepAboveTheFloor = (
      _events: readonly Y.YEvent<Y.XmlElement>[],
      transaction: Y.Transaction,
    ): void => {
      if (transaction.origin === RESTORE_ORIGIN) {
        return;
      }

      if (fragment.length === 0) {
        // Local emptyings only: a remote one is the producing peer's to answer - it runs this
        // same guard - and if every open editor answered a shared emptying, each would add its
        // own paragraph. (Two clients emptying concurrently can still merge to two
        // placeholders; the removal branch below cleans each side's own, and the server's
        // parse check remains the backstop for the races beyond that.)
        if (!transaction.local) {
          return;
        }
        doc.transact(() => {
          const paragraph = new Y.XmlElement('paragraph');
          fragment.insert(0, [paragraph]);
          restored = paragraph;
        }, RESTORE_ORIGIN);
        return;
      }

      const placeholder = restored;
      if (placeholder === null) {
        return;
      }

      // The placeholder stops being this guard's to manage the moment somebody types into it,
      // or something other than this guard removes it.
      if (placeholder.parent !== fragment || placeholder.length > 0) {
        restored = null;
        return;
      }

      // Real content is back alongside a placeholder still empty: take the placeholder out, so
      // a redo returns exactly the document the undo removed and not that plus a blank block.
      // Deliberately not gated on `transaction.local` - a colleague's edit arriving beside the
      // placeholder deserves the same cleanup, and it is safe on any origin because the guard
      // only ever deletes the one element it created, and only while that element is empty.
      if (fragment.length > 1) {
        doc.transact(() => {
          const index = fragment.toArray().indexOf(placeholder);
          if (index >= 0) {
            fragment.delete(index, 1);
          }
        }, RESTORE_ORIGIN);
        restored = null;
      }
    };

    fragment.observeDeep(keepAboveTheFloor);
    return () => {
      fragment.unobserveDeep(keepAboveTheFloor);
    };
  }, [doc, fragment]);

  useEffect(() => {
    const scope = documentScope(subject, workspaceId, itemId, documentPath ?? 'note');
    const sync = startCollabSync({
      itemId,
      documentPath,
      cacheScope: cacheBody ? scope : undefined,
      ...(scope === undefined ? {} : { draftScope: scope, onDraftState: setDraftState }),
      doc,
      awareness,
      fragmentName: FRAGMENT_NAME,
      getAccessToken,
      onState: (state) => {
        if (state === 'readonly') setReadOnly(true);
        else if (state === 'live') setReadOnly(false);
        // A fresh connection means whatever was refused before may not still apply to what is
        // about to be resynced - the error is about the last update, not a standing fact.
        if (state === 'live') {
          setRefusal(null);
          setNoticeCode(null);
        }
        setSyncState(state);
      },
      onInitialSync: () => {
        setSynced(true);
      },
      onNotice: (notice) => {
        setNoticeCode(notice.code);
        if (notice.code === LOCAL_COPY_STALE) setStale(true);
        if (
          notice.code === 'offline_copy_unavailable' ||
          notice.code === 'body_access_unavailable' ||
          notice.code === 'access_revoked'
        ) {
          setReadOnly(true);
          setRefusal(notice.detail);
        }
        const copy = REFUSAL_COPY[notice.code];
        if (copy !== undefined) {
          setRefusal(copy);
        }
      },
    });
    onSync?.(sync);

    return () => {
      onSync?.(null);
      sync.destroy();
    };
  }, [
    awareness,
    cacheBody,
    doc,
    documentPath,
    getAccessToken,
    itemId,
    onSync,
    subject,
    workspaceId,
  ]);

  // Who this cursor belongs to, told to everyone else. The color is picked by client
  // identifier so two tabs of the same person still read as two cursors.
  useEffect(() => {
    awareness.setLocalStateField('markdownMode', false);
    awareness.setLocalStateField('user', {
      name: profile?.name ?? 'Someone',
      color: cursorColorFor(doc.clientID),
    });
  }, [awareness, doc, profile]);

  const disposal = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (disposal.current !== null) clearTimeout(disposal.current);
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dropAbortRef.current?.abort();
      // StrictMode replays effect cleanup while retaining this document and editor.
      // Dispose only after a real unmount, once the replay can cancel the timer.
      disposal.current = setTimeout(() => {
        awareness.destroy();
        doc.destroy();
      }, 0);
    };
  }, [awareness, doc]);

  const insertHandlers = {
    onInsertItem: (kind: ItemInsertKind) => {
      if (uploadingFilesRef.current > 0) return;
      insertionRef.current = editor.state.selection.from;
      setItemRequest(kind);
    },
    onPageBreak: () => {
      insertPageBreak(editor);
    },
    onInsertImage: () => {
      insertionRef.current = editor.state.selection.from;
      setAddressRequest('image');
    },
  };

  const formatting =
    readOnly || stale ? null : (
      <div className={narrow ? 'flex items-center' : 'min-w-0 shrink-0 px-8'}>
        <div
          className={
            narrow
              ? 'flex items-center gap-2'
              : `${noteColumn} flex min-w-0 flex-wrap items-center justify-between gap-2`
          }
        >
          <EditorToolbar
            compact={narrow}
            editor={editor}
            writingMode={writingMode}
            writingModeControl={
              <>
                <WritingModeControl />
                <Button
                  variant="subtle"
                  className={`shrink-0 whitespace-nowrap ${markdownMode?.phase === 'open' ? 'bg-accent/18 text-foreground' : ''}`}
                  aria-pressed={markdownMode?.phase === 'open'}
                  // A round trip through Markdown would silently apply every suggestion.
                  disabled={suggestionsPending && markdownMode === null}
                  title={
                    suggestionsPending && markdownMode === null
                      ? 'Accept or reject the suggestions to use Markdown mode'
                      : undefined
                  }
                  onClick={() => {
                    if (markdownMode !== null) {
                      setMarkdownMode(null);
                      awareness.setLocalStateField('markdownMode', false);
                      return;
                    }
                    const snapshot = snapshotMarkdown(fragment);
                    if (snapshot.losses.length > 0) {
                      setMarkdownMode({ phase: 'confirming', snapshot });
                    } else {
                      setMarkdownMode({ phase: 'open', snapshot });
                      awareness.setLocalStateField('markdownMode', true);
                    }
                  }}
                >
                  Markdown
                </Button>
                {subject === undefined ? null : (
                  <SuggestingControl
                    editor={editor}
                    suggesting={suggesting}
                    pending={suggestionsPending}
                    onToggle={() => {
                      setSuggestingOn(!suggesting);
                      try {
                        if (suggesting) localStorage.removeItem(suggestingKey);
                        else localStorage.setItem(suggestingKey, '1');
                      } catch {
                        // Not remembered; the switch still works for this session.
                      }
                    }}
                  />
                )}
              </>
            }
            textWidthControl={narrow ? undefined : <TextWidthControl />}
            {...insertHandlers}
            onInsertLink={() => {
              insertionRef.current = editor.state.selection.from;
              setAddressRequest('link');
            }}
            // The Yjs history, so undo reverts your own edits and never a colleague's. Passed in
            // rather than imported by the toolbar, which has no business knowing the document is a
            // CRDT.
            onUndo={() => {
              if (undo(editor.state)) {
                editor.view.focus();
              }
            }}
            onRedo={() => {
              if (redo(editor.state)) {
                editor.view.focus();
              }
            }}
          />
          {writingMode === 'collaboration' ? null : <PresenceList awareness={awareness} />}
        </div>
      </div>
    );
  return (
    // One resolver per open document. Every reference in the note asks it for its target, and it
    // sends one request for all of them - which is the difference between opening a note with
    // forty links and opening forty connections.
    <NoteSourcesProvider
      {...(subject !== undefined && workspaceId !== undefined
        ? { localScope: { subject, workspaceId } }
        : {})}
    >
      <ReferenceResolutionProvider>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <Text id={vimDescriptionId} variant="note" className="sr-only">
              Vim basics starts in Normal mode. Press i to insert text, Escape to return to Normal,
              and v or V for Visual mode.
            </Text>
            {hideToolbar ? null : narrow ? (
              <MobileNoteToolbar
                editor={editor}
                formatting={formatting}
                actions={mobileActions}
                details={mobileDetails}
              />
            ) : (
              formatting
            )}

            <PendingReferenceNotice itemId={itemId} editor={editor} />
            {writingMode === 'collaboration' && !hideToolbar ? (
              <div
                aria-label="Collaboration status"
                className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 px-5 py-2 sm:px-8"
              >
                <Text variant="caption" tone="muted">
                  {
                    {
                      connecting: 'Connecting to collaborators',
                      live: 'Live editing',
                      pending: 'Saving shared changes',
                      readonly: 'Shared note is read-only',
                      degraded: 'Connection interrupted',
                      offline: 'Working offline',
                    }[syncState]
                  }
                </Text>
                <PresenceList awareness={awareness} />
              </div>
            ) : null}
            <PaneViewport
              scrollKey={`${workspaceId ?? ''}:${itemId}:${documentPath ?? 'body'}`}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain px-5 pb-24 pt-4 sm:px-8 sm:pt-6 lg:pb-6"
            >
              {dropActive ? (
                <Text
                  variant="note"
                  tone="accent"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="mb-4 rounded-md border border-accent/40 bg-accent/10 px-3 py-2"
                >
                  Drop to add files to this note. Images will appear here; other files become links.
                </Text>
              ) : null}
              {uploadingFiles > 0 ? (
                <Text
                  variant="note"
                  tone="muted"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="mb-4"
                >
                  Adding {uploadingFileName ?? 'file'} ({String(uploadingFileIndex)} of{' '}
                  {String(uploadingFiles)})…
                </Text>
              ) : null}
              {readOnly || stale ? null : (
                <SlashMenu
                  editor={editor}
                  {...insertHandlers}
                  onInlineAi={inlineAi.available ? inlineAi.start : undefined}
                />
              )}
              {readOnly || stale ? null : (
                <ReferenceMenu
                  editor={editor}
                  workspaceId={workspaceId}
                  itemId={itemId}
                  parentId={parentId}
                />
              )}
              {/*
            The block handle: hover a block and a grip appears in the margin; dragging it moves
            the block. The component registers the drag-handle plugin itself and portals this
            content into an element the plugin owns - so its position in this JSX is not its
            position in the DOM; the plugin appends it beside the editor and shows it only while
            a block is hovered. It needs no coordination with the slash, reference or bubble
            menus for a plainer reason than timing: they occupy different regions. The handle
            lives in the gutter to the left of the block; the menus float at the caret or over
            the selection, inline. Nothing overlaps.

            Accessibility, on the true record. The handle is an HTML5 drag affordance, which is
            pointer-only by nature. It adds no capability a keyboard user lacks - block order is
            keyboard-reachable, by `MoveBlock`'s `Mod-Shift-ArrowUp`/`Mod-Shift-ArrowDown` above
            and the compact toolbar's "Move up"/"Move down" - so hiding the handle from
            assistive technology costs nothing (no WCAG 2.1.1 regression) while announcing it
            would promise a control a screen reader cannot operate. Concretely: the glyph
            carries aria-hidden (the Icon default when unlabeled), and the wrapper the plugin
            positions is a role-less, name-less div, so nothing here reaches the accessibility
            tree - which is the right outcome.
          */}
              {readOnly || stale ? null : (
                <DragHandle
                  editor={editor}
                  className="flex cursor-grab items-center justify-center rounded-sm p-1 text-muted hover:bg-foreground/7 hover:text-foreground data-[dragging=true]:cursor-grabbing"
                >
                  <Icon icon={GripVertical} size="sm" />
                </DragHandle>
              )}
              {/*
            The positioned box the page guides are measured in. `h-full` keeps what
            `EditorContent` had: the editor fills the viewport, so a click below a short note
            still lands in it.
          */}
              {markdownMode?.phase === 'open' ? (
                <MarkdownModePanel
                  doc={doc}
                  fragment={fragment}
                  snapshot={markdownMode.snapshot}
                  onClose={() => {
                    setMarkdownMode(null);
                    awareness.setLocalStateField('markdownMode', false);
                  }}
                />
              ) : null}
              {markdownMode?.phase === 'confirming' ? (
                <MarkdownLossesDialog
                  snapshot={markdownMode.snapshot}
                  onContinue={() => {
                    setMarkdownMode({ phase: 'open', snapshot: markdownMode.snapshot });
                    awareness.setLocalStateField('markdownMode', true);
                  }}
                  onCancel={() => {
                    setMarkdownMode(null);
                  }}
                />
              ) : null}
              {/* Hidden, not unmounted, while the Markdown textarea is up: the sync binding,
                    presence and undo history stay attached to the document underneath. */}
              <div
                ref={setSurface}
                hidden={markdownMode?.phase === 'open'}
                data-text-width={narrow ? 'reading' : textWidth}
                className={`relative h-full min-w-0 ${noteColumn} ${
                  !narrow && textWidth === 'full'
                    ? 'max-w-none [&_.ProseMirror]:max-w-none'
                    : WRITING_MODES[writingMode].measure
                }`}
              >
                {bodyUnavailable ? (
                  <Text variant="note" tone="muted" role="status">
                    Nix can no longer show this note. Restore access and reopen it to continue.
                  </Text>
                ) : (
                  <MermaidCaptureContext.Provider value={captureDiagram}>
                    <EditorContent
                      editor={editor}
                      className="h-full"
                      onDragEnterCapture={(event) => {
                        if (hasFilePayload(event)) setDropActive(true);
                      }}
                      onDragOverCapture={(event) => {
                        if (hasFilePayload(event)) {
                          event.preventDefault();
                          setDropActive(true);
                        }
                      }}
                      onDragLeaveCapture={(event) => {
                        if (
                          hasFilePayload(event) &&
                          !event.currentTarget.contains(event.relatedTarget as Node | null)
                        ) {
                          setDropActive(false);
                        }
                      }}
                      onDropCapture={(event) => {
                        setDropActive(false);
                        if (handleFileDrop(editor.view, event.nativeEvent)) {
                          event.stopPropagation();
                        }
                      }}
                    />
                  </MermaidCaptureContext.Provider>
                )}
                {/* Where the exported pages would break, drawn over the text as it is written. */}
                {!bodyUnavailable && pageGuides === 'shown' ? (
                  <PageGuides editor={editor} host={surface} />
                ) : null}
              </div>
              {/* After the editable region on purpose: Tab from the text is what reaches its buttons. */}
              {stale || bodyUnavailable ? null : (
                <BubbleMenu
                  editor={editor}
                  onComment={
                    canComment === true
                      ? () => {
                          requestComment(itemId, captureAnchor(editor.view));
                        }
                      : undefined
                  }
                  onOpenInlineAi={
                    inlineAi.available
                      ? () => {
                          inlineAi.start(null);
                        }
                      : undefined
                  }
                />
              )}
              {readOnly || stale ? null : <InlineAiPanel editor={editor} controller={inlineAi} />}
              <MentionBubble editor={editor} />
              {readOnly || stale ? null : <TableMenu editor={editor} />}
            </PaneViewport>
            {hideToolbar || narrow || bodyUnavailable ? null : <NoteStatsFooter editor={editor} />}

            {itemRequest !== null && workspaceId !== undefined ? (
              <ItemInsertDialog
                kind={itemRequest}
                workspaceId={workspaceId}
                parentId={itemId}
                onCancel={() => {
                  setItemRequest(null);
                  focusAfterDialog(editor);
                }}
                onFiles={(files) => {
                  void uploadDroppedFiles(
                    editor.view,
                    files,
                    insertionRef.current ?? editor.state.selection.from,
                  );
                }}
                onInsert={(id, presentation, label) => {
                  if (editor.isDestroyed || !editor.isEditable) return false;
                  const position = insertionRef.current ?? editor.state.selection.from;
                  const content =
                    presentation === 'image'
                      ? { type: 'image', attrs: { fileItemId: id, src: '', alt: label } }
                      : presentation === 'inline'
                        ? { type: 'reference', attrs: { kind: 'item', targetId: id, label } }
                        : { type: 'itemBlock', attrs: { targetId: id, presentation } };
                  const inserted = editor
                    .chain()
                    .setTextSelection(position)
                    .insertContent(
                      presentation === 'inline' ? content : [content, { type: 'paragraph' }],
                    )
                    .run();
                  if (inserted) focusAfterDialog(editor);
                  return inserted;
                }}
              />
            ) : null}
            {uploadingFiles > 0 ? (
              <Button
                variant="secondary"
                onClick={() => {
                  dropAbortRef.current?.abort();
                }}
              >
                Cancel upload
              </Button>
            ) : null}
            {uploadingFiles === 0 && retryFiles.length > 0 ? (
              <Button
                variant="secondary"
                onClick={() => {
                  void uploadDroppedFiles(
                    editor.view,
                    retryFiles,
                    insertionRef.current ?? editor.state.selection.from,
                  );
                }}
              >
                Retry remaining files
              </Button>
            ) : null}
            {addressRequest === null ? null : (
              <EditorAddressDialog
                kind={addressRequest}
                onCancel={() => {
                  setAddressRequest(null);
                }}
                onSubmit={({ address, description }) => {
                  if (!editor.isEditable)
                    throw new Error('This note is read-only. Changes cannot be added.');
                  const request = addressRequest;
                  if (editor.isDestroyed) {
                    return;
                  }

                  if (request === 'image' && insertionRef.current !== null)
                    editor.commands.setTextSelection(insertionRef.current);
                  // Commit before closing. Deferring the document mutation would create a gap where
                  // changing tabs can unmount this editor after the validated form has disappeared but
                  // before its command runs, silently losing the submission. The command itself does
                  // not focus, so it is safe while the modal still makes the editor inert.
                  if (request === 'image') {
                    // Leave a text block after the image. Besides giving the writer somewhere obvious
                    // to continue, this keeps the collaborative selection inside an inline-capable
                    // node instead of forcing it onto the document boundary.
                    editor
                      .chain()
                      .setImage({ src: address, alt: description })
                      .createParagraphNear()
                      .run();
                  } else {
                    editor.chain().setLink({ href: address }).run();
                  }

                  setAddressRequest(null);
                  focusAfterDialog(editor);
                }}
                onExistingImage={() => {
                  setAddressRequest(null);
                  setItemRequest('image');
                }}
                onUploadImage={async (file, description) => {
                  const inserted = await uploadDroppedFiles(
                    editor.view,
                    [file],
                    insertionRef.current ?? editor.state.selection.from,
                    description,
                    false,
                  );
                  if (!inserted)
                    throw new Error('The image was not inserted. Retry the upload or cancel.');
                  focusAfterDialog(editor);
                }}
              />
            )}

            {presetStatus === null ? null : (
              <div className="flex min-w-0 items-baseline gap-3 px-8 py-1.5">
                <Text
                  variant="caption"
                  as="p"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="shrink-0 font-heading font-semibold tracking-wider text-muted"
                >
                  <span className="uppercase">{presetStatus.label}</span>
                  {presetStatus.recording === null ? null : (
                    <span className="uppercase"> · {presetStatus.recording}</span>
                  )}
                  {presetStatus.message === '' ? null : (
                    <span className="font-normal"> · {presetStatus.message}</span>
                  )}
                </Text>
                {/* The command being typed, kept out of the live region so it is not read per key. */}
                <Text variant="caption" as="p" className="min-w-0 truncate font-mono text-muted">
                  {presetStatus.keys}
                </Text>
              </div>
            )}
          </div>
          <DocumentIssueDialog
            noun="note"
            state={syncState}
            draftState={draftState}
            stale={stale}
            refusal={refusal}
            paused={addressRequest !== null || itemRequest !== null}
            reloadRequired={noticeCode === 'schema_version_mismatch'}
          />
        </div>
      </ReferenceResolutionProvider>
    </NoteSourcesProvider>
  );
}

function insertPageBreak(editor: Editor): void {
  const { $from } = editor.state.selection;
  if ($from.depth > 1) return;
  editor.chain().focus().insertContent({ type: 'pageBreak' }).createParagraphNear().run();
}
