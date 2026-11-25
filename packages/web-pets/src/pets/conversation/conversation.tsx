// The conversation with the pet - header, messages, composer and the settings and history
// sub-panels - kept apart from the floating launcher in `pet-companion.tsx` so a page can render
// the same conversation without the launcher, the drag handling or the panel positioning. How it
// sits on screen is the caller's `layout`; everything inside is the same in all of them.
import {
  type PetConnection,
  type PetPlanSourceScope,
  type PetProfile,
  type PetSettings,
} from '@nix/api-client';
import { Button, Text, focusRing } from '@nix/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { usePaneIndex } from '@nix/web-platform/panes/pane-context';
import { selectedItemParam } from '@nix/web-platform/panes/pane-params';
import { NewChatNote } from '../chat/new-chat-note';
import { SaveInsightNote } from '../chat/save-insight-note';
import { petProviderLabels } from '../catalog';
import {
  readConversationModel,
  readReadWithoutAsking,
  readWorkspaceAccess,
  writeConversationModel,
  writeReadWithoutAsking,
  writeWorkspaceAccess,
} from '@nix/web-foundation/lib/device-preferences';
import { toolOutcomeSentence } from '../work-tools/receipts';
import { type PetAnimationState } from '../pet-avatar';
import { usePetDraft } from '@nix/web-foundation/lib/pet-drafts';
import { PetConnectionPanel } from '../pet-connection-panel';
import { type UsePetRuntimeResult } from '../use-pet-runtime';
import { Composer } from './composer/composer';
import { useSlashMenu } from './composer/use-slash-menu';
import { ConversationHeader } from './header/conversation-header';
import { conversationMenuItems } from './header/conversation-menu';
import { petSuggestions } from './messages/empty-state';
import { MessageList } from './messages/message-list';
import { useReplyAnnouncer } from './state/use-reply-announcer';
import { useStablePieces } from './state/use-stable-pieces';
import { HistoryPanel } from './panels/history-panel';
import { PetSettingsPanel } from './panels/settings-panel';
import { useApplySwitch } from './state/use-apply-switch';
import { useDialogBehaviour } from './state/use-dialog-behaviour';
import { useMessageContext } from './state/use-message-context';
import { statusText } from './state/status-text';
import { useRename } from './state/use-rename';
import { useResumeUndo } from './state/use-resume-undo';
import { PetHistory } from '../pet-history';
import { useTurns } from './state/use-turns';
import { sharingScope } from './state/sharing-scope';
import { useSharingConsent } from '@nix/web-platform/api/use-pet-sharing-consent';
import { type ConversationJobDraft, type ConversationJobs } from './conversation-jobs';

type ConversationPanel = 'chat' | 'settings' | 'history';
const emptyMessages: NonNullable<PetConnection['messages']> = [];

export type ConversationLayout = 'floating' | 'drawer' | 'fullscreen' | 'page';

export interface ConversationProps {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly layout: ConversationLayout;
  readonly runtimeApi: UsePetRuntimeResult;
  readonly onNeedsDecisionChange: (toolIds: readonly string[]) => void;
  readonly creationRequest?: {
    readonly id: string;
    readonly text: string;
    readonly onStarted: () => void;
  };
  readonly noteScope?: {
    readonly rootItemId: string;
    readonly title: string;
    readonly kindLabel?: string;
    readonly readOnly: boolean;
    readonly onReadOnlyChange: (readOnly: boolean) => void;
  };
  readonly jobs?: ConversationJobs;
  readonly inDialog?: boolean;
  readonly onClose?: () => void;
  /** Moves the conversation to its own page. Offered in the floating panel only; a prop rather
   * than a router call so `Conversation` stays free of the destination it would navigate to. */
  readonly onOpenAsPage?: () => void;
}

export function Conversation({
  workspaceId,
  pet,
  settings,
  layout,
  runtimeApi,
  onNeedsDecisionChange,
  onClose,
  onOpenAsPage,
  noteScope,
  creationRequest,
  jobs,
  inDialog = false,
}: ConversationProps): ReactElement {
  const fullscreen = layout === 'fullscreen';
  const smallScreen = useNarrowViewport();
  const zen = useZenActive();
  // Touch keyboards use Enter for a newline and open only after a deliberate tap.
  const touchLikeComposer =
    smallScreen ||
    (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  const client = useApiClient();
  const [search] = useSearchParams();
  // This pane's own item: a conversation shown in pane 2 is about pane 2's note.
  const pane = usePaneIndex();
  const currentItem = noteScope?.rootItemId ?? search.get(selectedItemParam(pane));
  const {
    runtime,
    models,
    busy,
    error,
    errorKind,
    setRuntime,
    regenerateRequestId,
    interrupt,
    reset,
    reload,
    retryWatch,
  } = runtimeApi;
  const [panel, setPanel] = useState<ConversationPanel>('chat');
  const [insight, setInsight] = useState<string | null>(null);
  const [saveChat, setSaveChat] = useState(false);
  // The draft lives in a small in-memory store rather than here so it survives the
  // conversation moving between the floating panel and its page.
  const [draft, setDraft] = usePetDraft(workspaceId, pet.id, noteScope?.rootItemId);
  const [draftRestorations, setDraftRestorations] = useState(0);
  const [model, setModel] = useState(() =>
    readConversationModel(workspaceId, pet.id, pet.provider),
  );
  const [workspaceAccessPreference, setWorkspaceAccess] = useState(() =>
    readWorkspaceAccess(workspaceId, pet.id),
  );
  const [contextChoice, setContextChoice] = useState<{
    readonly identity: string;
    readonly include: boolean;
  } | null>(null);
  const contextIdentity = `${workspaceId}:${pet.id}:${noteScope?.rootItemId ?? ''}`;
  const planConsent = jobs?.consentMode === 'plan';
  const workspaceAccess =
    noteScope !== undefined ||
    (planConsent
      ? contextChoice?.identity === contextIdentity
        ? contextChoice.include
        : true
      : workspaceAccessPreference);
  const [readWithoutAsking, setReadWithoutAsking] = useState(() => readReadWithoutAsking());
  const [needsDecisionIds, setNeedsDecisionIds] = useState<readonly string[]>([]);
  // The last user message, being edited in place: its id pins the edit to that message.
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | null>(
    null,
  );
  const currentEdit = useRef(editing);
  useEffect(() => {
    currentEdit.current = editing;
  }, [editing]);
  const input = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (draftRestorations > 0) input.current?.focus();
  }, [draftRestorations]);
  const dialog = useRef<HTMLDivElement | null>(null);
  // Must-fix 7: `Text` deliberately takes no `ref`/`tabIndex` (its own contract refuses an open
  // prop spread), so the focus target on open is a plain wrapper around the visible `<h3>` -
  // still announced as a level-3 heading, just not itself the tab stop.
  const panelHeading = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<{ current: HTMLButtonElement | null } | null>(null);
  const messages = runtime?.messages ?? emptyMessages;
  // Each message's view of the generated-UI blocks before it, so a patch can find what it changes.
  const runtimeMessages = runtime?.messages;
  const piecesBefore = useStablePieces(runtimeMessages ?? []);
  const running = runtime?.state === 'thinking';
  const approvalPending = needsDecisionIds.length > 0;
  const { applyWithoutAsking, applyExemptToolIds, setApplyWithoutAsking } = useApplySwitch({
    workspaceId,
    petId: pet.id,
    savedDefault: pet.applyWithoutAsking,
    readOnly: noteScope?.readOnly ?? false,
    needsDecisionIds,
    loaded: runtime !== null,
    conversationKey: messages[0]?.id ?? '',
    pendingToolIds: (runtime?.tools ?? [])
      .filter((tool) => tool.status === 'pending')
      .map((tool) => tool.id),
  });
  const hasDraft = messages.some((message) => message.id.includes(':draft:'));
  const animation: PetAnimationState = approvalPending
    ? 'awaiting-approval'
    : running || busy
      ? 'thinking'
      : error || runtime?.state === 'error'
        ? 'error'
        : runtime?.state === 'success'
          ? 'success'
          : 'idle';
  const errored = Boolean(error) || runtime?.state === 'error';
  const connected = runtime?.status === 'connected';
  const announcement = useReplyAnnouncer({
    messages,
    petName: pet.name,
    ready: connected,
    approvalPending,
    outcome: toolOutcomeSentence(runtime?.tools?.at(-1)),
  });

  // Stable identity: `PetWorkTools` re-fires its own reporting effect whenever the callback it
  // was given changes identity, so a plain function redefined on every render here would make
  // that effect (and the render it triggers) loop forever, given the needs-decision array it
  // reports is itself a fresh array each time even when unchanged in content.
  const reportNeedsDecision = useCallback(
    (toolIds: readonly string[]) => {
      setNeedsDecisionIds(toolIds);
      onNeedsDecisionChange(toolIds);
    },
    [onNeedsDecisionChange],
  );

  /** Closing the message editor removes the control that had focus, so focus goes to the composer. */
  function closeEditor(replacement?: { readonly id: string; readonly text: string }) {
    if (
      replacement !== undefined &&
      (currentEdit.current?.id !== replacement.id || currentEdit.current.text !== replacement.text)
    )
      return;
    setEditing(null);
    input.current?.focus();
  }

  const context = useMessageContext({
    currentItem,
    noteScope,
    workspaceAccess,
    autoAttachPage: !planConsent,
  });
  function chooseWorkspaceContext(include: boolean): void {
    setContextChoice({ identity: contextIdentity, include });
    if (!planConsent) {
      setWorkspaceAccess(include);
      writeWorkspaceAccess(workspaceId, pet.id, include);
    }
    if (!include) setApplyWithoutAsking(false);
  }
  const acceptedScope = useRef<PetPlanSourceScope | null>(null);
  const sourceScope = (access: boolean, fields: object): PetPlanSourceScope | null =>
    sharingScope(noteScope?.rootItemId, access, fields);
  const sharing = useSharingConsent({
    client,
    workspaceId,
    petId: pet.id,
    selectionKey: JSON.stringify({
      provider: pet.provider,
      workspaceAccess,
      noteScope: noteScope?.rootItemId,
      sources: context.contexts.map((entry) => ({
        itemId: entry.itemId,
        sharedText: entry.sharedText,
      })),
    }),
  });
  const { submit, resendTurn, retryLastTurn, retryLabel, retryError, loadErrorMessage, preparing } =
    useTurns({
      client,
      workspaceId,
      runtimeApi,
      petName: pet.name,
      draft,
      setDraft,
      model,
      workspaceAccess,
      hasNoteScope: noteScope !== undefined,
      messages,
      contextFields: context.contextFields,
      onSent: closeEditor,
      consentMode: jobs?.consentMode,
      onAccepted: ({ workspaceAccess: access, context: fields }) => {
        acceptedScope.current = sourceScope(access, fields);
      },
      beforeDisclosure: async ({ workspaceAccess: access, context: fields }) => {
        return sharing.ensure(sourceScope(access, fields));
      },
    });
  useEffect(() => {
    const batch = runtime?.plannedBatch;
    if (
      jobs?.consentMode !== 'plan' ||
      jobs.adoptTools === undefined ||
      batch?.ready !== true ||
      typeof batch.requiresReadDecision !== 'boolean' ||
      batch.scope == null ||
      (noteScope?.readOnly === true && !batch.scope.readOnly)
    )
      return;
    const scope = batch.sourceScope ?? acceptedScope.current;
    if (scope === null) return;
    const last = messages.findLast((message) => !message.id.includes(':draft:'))?.id;
    jobs.adoptTools({
      conversationId: batch.conversationId,
      turnId: batch.turnId,
      toolIds: batch.toolIds,
      sourceScope: scope,
      brief:
        messages.findLast((message) => message.role === 'user')?.text ??
        'Review the prepared changes from this conversation',
      ...(last === undefined ? {} : { afterMessageId: last }),
      rootItemId: batch.scope.rootItemId,
      readOnly: batch.scope.readOnly,
    });
  }, [jobs, runtime?.plannedBatch, messages, noteScope]);

  const jobDraft: ConversationJobDraft = {
    text: draft,
    restore: (text) => {
      setDraft((current) => (current.trim() === '' ? text : current));
      setDraftRestorations((current) => current + 1);
    },
    onStarted: () => {
      setDraft((current) => (current === draft ? '' : current));
    },
  };
  const canRouteToJob = jobs !== undefined && context.contexts.length === 0;
  // The person's choice for this draft; null leaves it to the wording.
  const [routeOverride, setRouteOverride] = useState<'chat' | 'job' | null>(null);
  if (routeOverride !== null && !draft.trim()) setRouteOverride(null);
  const jobAllowed = canRouteToJob && jobs.ready;
  const route: 'chat' | 'job' =
    routeOverride ?? (canRouteToJob && jobs.canSubmit(draft) ? 'job' : 'chat');
  const routeUnavailable =
    route === 'job'
      ? context.contexts.length > 0
        ? 'Remove attached notes to start a job.'
        : !jobAllowed
          ? 'Jobs are unavailable. Try again when jobs are ready.'
          : undefined
      : !connected
        ? 'Chat is disconnected. Reconnect to send as chat.'
        : undefined;
  const canSend = !busy && !preparing && !jobs?.busy && Boolean(draft.trim()) && !routeUnavailable;

  function submitMessage(): void {
    if (!canSend || running) return;
    if (route === 'job') {
      jobs?.submit(
        {
          ...jobDraft,
          afterMessageId: messages.findLast((message) => !message.id.includes(':draft:'))?.id,
          focusComposer: () => input.current?.focus(),
        },
        routeOverride === 'job' ? true : undefined,
      );
      return;
    }
    if (connected) void submit();
  }

  const attachMessage = jobs?.busy ? undefined : jobs?.attachMessage;

  const attemptedCreation = useRef<string | null>(null);
  const [creationRetry, setCreationRetry] = useState<string | null>(null);
  useEffect(() => {
    if (
      !creationRequest ||
      attemptedCreation.current === creationRequest.id ||
      !connected ||
      running ||
      busy ||
      preparing ||
      approvalPending
    )
      return;
    attemptedCreation.current = creationRequest.id;
    void submit(creationRequest.text, creationRequest.onStarted, creationRequest.id)
      .then((accepted) => {
        if (!accepted) setCreationRetry(creationRequest.id);
      })
      .catch(() => {
        setCreationRetry(creationRequest.id);
      });
  }, [creationRequest, connected, running, busy, preparing, approvalPending, submit]);

  const rename = useRename({
    workspaceId,
    petId: pet.id,
    rootItemId: noteScope?.rootItemId,
    currentTitle: runtime?.title,
    setRuntime,
  });
  const undoResume = useResumeUndo({
    workspaceId,
    petId: pet.id,
    rootItemId: noteScope?.rootItemId,
    setRuntime,
  });
  // The conversation list beside the chat reloads whenever the live conversation changes.
  const listKey = `${messages[0]?.id ?? ''}:${runtime?.title ?? ''}`;

  function goBackFromPanel() {
    setPanel('chat');
    menuTrigger.current?.current?.focus();
  }

  useDialogBehaviour({
    dialog,
    panelHeading,
    input,
    panel,
    fullscreen,
    drawer: layout === 'drawer',
    touchLikeComposer,
    onClose,
    goBackFromPanel,
  });

  useEffect(() => {
    const changed = () => {
      setReadWithoutAsking(readReadWithoutAsking());
    };
    window.addEventListener('nix-pet-device-changed', changed);
    return () => {
      window.removeEventListener('nix-pet-device-changed', changed);
    };
  }, []);

  const menuItems = conversationMenuItems({
    workspaceId,
    petName: pet.name,
    openNoteId: noteScope?.rootItemId,
    layout,
    messages,
    inactive: busy || running || preparing,
    onSaveChat: () => {
      setSaveChat(true);
    },
    onNewConversation: () => {
      context.setAutoPageOff(false);
      setContextChoice(null);
      const hadMessages = messages.length > 0;
      void reset().then(() => {
        undoResume('Started a new conversation', hadMessages);
      });
    },
    onRename: () => {
      setPanel('chat');
      rename.startRename();
    },
    onHistory: () => {
      setPanel('history');
    },
    onReload: () => {
      void reload();
    },
    onOpenAsPage,
    onSettings: () => {
      setPanel('settings');
    },
  });

  function resumeFromList(resumed: PetConnection) {
    const hadMessages = messages.length > 0;
    setRuntime(resumed);
    undoResume(`Opened ${resumed.title || 'a past conversation'}`, hadMessages);
  }

  const suggestions = petSuggestions(Boolean(currentItem));
  const slash = useSlashMenu(draft, suggestions, pickSuggestion);

  /** A generated-UI button's request: filled in, never sent, so the owner reads what a component
   * asks for (it may be a change) before the pet sees it. */
  function askFromComponent(text: string) {
    if (jobs?.busy) return;
    setDraft(text);
    input.current?.focus();
  }

  /** An action from the empty state or the slash menu: it fills the composer, and "Summarize
   * this page" also attaches the open page. */
  function pickSuggestion(suggestion: string) {
    if (jobs?.busy) return;
    setDraft(suggestion);
    if (suggestion === 'Summarize this page') context.attachPageContext();
    regenerateRequestId();
    input.current?.focus();
  }

  if (noteScope && !runtime && error && jobs === undefined) {
    return (
      <div className="flex min-w-0 flex-col gap-2 p-3">
        <Text role="alert">{error}</Text>
        <Link
          to={`/w/${workspaceId}?item=${noteScope.rootItemId}`}
          className={`underline ${focusRing}`}
        >
          Open the note
        </Link>
      </div>
    );
  }

  const hasJobEntries = (jobs?.timeline.length ?? 0) > 0;
  const statusDimension = hasJobEntries ? 'max-h-1/3 shrink-0' : 'flex-1';
  const scopeKind = noteScope?.kindLabel ?? 'Note';

  return (
    <div
      ref={dialog}
      role={inDialog ? 'region' : 'dialog'}
      tabIndex={-1}
      aria-modal={inDialog ? undefined : fullscreen}
      aria-label={`Conversation with ${pet.name}`}
      className={dialogClass(layout)}
    >
      {layout === 'page' ? (
        // Wide enough, the past conversations stay beside the chat instead of behind a menu.
        <aside
          aria-label="Conversations"
          className="hidden w-72 shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-r border-divider bg-surface p-3 @4xl:flex"
        >
          <Text as="h2" variant="h3">
            Conversations
          </Text>
          <PetHistory
            key={listKey}
            workspaceId={workspaceId}
            petId={pet.id}
            name={pet.name}
            client={client}
            rootItemId={noteScope?.rootItemId}
            running={running || busy || preparing}
            onResumed={(resumed) => {
              resumeFromList(resumed);
              input.current?.focus();
            }}
          />
        </aside>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>
        {insight !== null ? (
          <SaveInsightNote
            text={insight}
            onClose={() => {
              setInsight(null);
            }}
          />
        ) : null}
        {saveChat ? (
          <NewChatNote
            sourceWorkspaceIds={[workspaceId]}
            messages={messages.map((message) => ({ role: message.role, text: message.text }))}
            onClose={() => {
              setSaveChat(false);
            }}
          />
        ) : null}
        <ConversationHeader
          layout={layout}
          zen={zen}
          petName={pet.name}
          appearance={pet.appearance}
          animation={animation}
          status={statusText({
            runtimeLoaded: Boolean(runtime),
            connected,
            errored,
            hasDraft,
            needsDecision: approvalPending,
            running,
          })}
          title={runtime?.title}
          renaming={rename.renaming}
          renameBusy={rename.renameBusy}
          renameError={rename.renameError}
          onRename={(title) => {
            void rename.renameConversation(title);
          }}
          onCancelRename={rename.cancelRename}
          menuItems={menuItems}
          menuTrigger={menuTrigger}
          onClose={onClose}
          noteScope={noteScope}
          locked={running || busy || preparing}
        />
        {panel === 'settings' ? (
          <PetSettingsPanel
            pet={pet}
            workspaceId={workspaceId}
            model={model}
            models={models}
            running={running || busy || preparing}
            runtime={runtime}
            readWithoutAsking={readWithoutAsking}
            headingRef={panelHeading}
            onModelChange={(next) => {
              setModel(next);
              writeConversationModel(workspaceId, pet.id, pet.provider, next);
            }}
            onReadWithoutAskingChange={(next) => {
              setReadWithoutAsking(next);
              writeReadWithoutAsking(next);
            }}
            onBack={goBackFromPanel}
          />
        ) : panel === 'history' ? (
          <HistoryPanel
            headingRef={panelHeading}
            onBack={goBackFromPanel}
            workspaceId={workspaceId}
            petId={pet.id}
            name={pet.name}
            client={client}
            rootItemId={noteScope?.rootItemId}
            running={running || busy || preparing}
            onResumed={(resumed) => {
              resumeFromList(resumed);
              goBackFromPanel();
            }}
          />
        ) : !runtime ? (
          // Must-fix 11/12: while nothing has ever loaded yet, the body says so plainly instead of
          // showing the empty-state suggestions as if the conversation were simply quiet - and once
          // a load error shows up here, it replaces the "Loading" text rather than sitting beside it.
          <div
            className={`flex min-h-0 flex-col items-center justify-center gap-2 overflow-y-auto p-4 text-center ${statusDimension}`}
          >
            {errorKind === 'load' && error ? (
              <>
                <Text role="alert">{loadErrorMessage}</Text>
                <Button variant="ghost" onClick={retryWatch}>
                  Retry now
                </Button>
              </>
            ) : (
              <Text variant="note" tone="muted">
                Loading conversation…
              </Text>
            )}
          </div>
        ) : !connected ? (
          <div className={`min-h-0 overflow-y-auto p-4 ${statusDimension}`}>
            {pet.provider === 'chatgpt' ? (
              <PetConnectionPanel />
            ) : (
              <div className="flex flex-col gap-3">
                <Text role="alert">
                  {runtime.reason ||
                    `Set up ${petProviderLabels[pet.provider]} in Companion settings to chat.`}
                </Text>
                <Link
                  to={`/w/${workspaceId}/settings?tab=pets`}
                  className={`underline ${focusRing}`}
                >
                  <Text as="span">Open Companion settings</Text>
                </Link>
              </div>
            )}
          </div>
        ) : (
          <>
            <MessageList
              client={client}
              workspaceId={workspaceId}
              pet={pet}
              settings={settings}
              runtime={runtime}
              messages={messages}
              piecesBefore={piecesBefore}
              running={running}
              busy={busy}
              hasDraft={hasDraft}
              approvalPending={approvalPending}
              workspaceAccess={workspaceAccess}
              suggestions={suggestions}
              onPick={pickSuggestion}
              onAsk={askFromComponent}
              setRuntime={setRuntime}
              reportNeedsDecision={reportNeedsDecision}
              applyWithoutAsking={applyWithoutAsking}
              applyExemptToolIds={applyExemptToolIds}
              noteScope={noteScope}
              editing={editing}
              setEditing={(value) => {
                if (value === null) closeEditor();
                else setEditing(value);
              }}
              enterToSend={!touchLikeComposer}
              resendTurn={resendTurn}
              retryLastTurn={retryLastTurn}
              onSaveInsight={setInsight}
              jobEntries={jobs?.timeline}
              onAttachToJob={
                attachMessage === undefined
                  ? undefined
                  : (text) => {
                      setDraft(attachMessage(text, draft));
                      regenerateRequestId();
                      input.current?.focus();
                    }
              }
            />
            {error ? (
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-divider px-3 py-2 @sm:px-4">
                <Text role="alert">{errorKind === 'load' ? loadErrorMessage : error}</Text>
                {error && retryLabel() && !(creationRequest != null && errorKind === 'send') ? (
                  <Button variant="ghost" onClick={retryError}>
                    {retryLabel()}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
        {panel === 'chat' && !connected && hasJobEntries ? (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
            {jobs?.timeline.map((entry) => (
              <div key={entry.id}>{entry.content}</div>
            ))}
          </div>
        ) : null}
        {panel === 'chat' && (connected || jobs?.ready || draft.trim()) ? (
          <Composer
            petName={pet.name}
            scopeLabel={
              noteScope !== undefined
                ? `${scopeKind}: ${noteScope.title}${noteScope.readOnly ? ' (read only)' : ''}`
                : planConsent
                  ? workspaceAccess
                    ? 'Workspace chat · workspace context included'
                    : 'Workspace chat · message only'
                  : workspaceAccess
                    ? 'Workspace chat · workspace access on'
                    : 'Workspace chat · workspace access off'
            }
            input={input}
            draft={draft}
            readOnly={preparing || (jobs?.busy ?? false)}
            onDraftChange={(text) => {
              setDraft(text);
              regenerateRequestId();
            }}
            touchLikeComposer={touchLikeComposer}
            slash={slash}
            onSubmit={submitMessage}
            onInterrupt={() => void interrupt()}
            running={running}
            canSend={canSend}
            preparing={preparing}
            route={route}
            routeUnavailable={routeUnavailable}
            onFlip={
              (route === 'job' ? connected : jobAllowed)
                ? () => {
                    setRouteOverride(route === 'job' ? 'chat' : 'job');
                    input.current?.focus();
                  }
                : undefined
            }
            chips={context.chips}
            onRemoveChip={context.removeContext}
            needsWorkspaceAccess={context.contexts.length > 0 && !workspaceAccess}
            onTurnOnWorkspaceAccess={() => {
              chooseWorkspaceContext(true);
            }}
            workspaceAccess={workspaceAccess}
            hasNoteScope={noteScope !== undefined}
            noteReadOnly={noteScope?.readOnly ?? false}
            onToggleWorkspaceAccess={() => {
              chooseWorkspaceContext(!workspaceAccess);
            }}
            applyWithoutAsking={applyWithoutAsking}
            onApplyChange={setApplyWithoutAsking}
            planConsent={planConsent}
            hasPage={Boolean(currentItem)}
            contextCount={context.contexts.length}
            hasSelection={context.hasSelection}
            onAttachPage={context.attachPageContext}
            onShareSelection={context.shareSelection}
          />
        ) : null}
        {panel === 'chat' && jobs ? (
          <div className="min-h-0 max-h-1/2 shrink-0 overflow-y-auto overscroll-contain">
            {jobs.panel(jobDraft)}
            {jobs.options}
          </div>
        ) : null}
        {panel === 'chat' && creationRequest?.id === creationRetry ? (
          <div className="flex min-w-0 flex-col gap-2 px-3 pb-3">
            <Text role="status" variant="note">
              This request has not been confirmed. Your draft is still here.
            </Text>
            <div>
              <Button
                disabled={busy || preparing || running}
                onClick={() => {
                  setCreationRetry(null);
                  void submit(creationRequest.text, undefined, creationRequest.id)
                    .then((accepted) => {
                      if (accepted) creationRequest.onStarted();
                      else setCreationRetry(creationRequest.id);
                    })
                    .catch(() => {
                      setCreationRetry(creationRequest.id);
                    });
                }}
              >
                Retry creation request
              </Button>
            </div>
          </div>
        ) : null}
        {panel === 'chat' ? (
          <div className="min-h-0 shrink-0 overflow-y-auto px-3 pb-3">{sharing.panel}</div>
        ) : null}
      </div>
    </div>
  );
}

function dialogClass(layout: ConversationLayout): string {
  if (layout === 'drawer') {
    return '@container fixed right-0 top-[var(--phone-dialog-top,0)] flex h-[var(--phone-dialog-height,100dvh)] w-128 max-w-full flex-col overflow-hidden border-l border-divider bg-background text-foreground shadow-lg outline-none motion-safe:transition-transform motion-safe:duration-200 motion-safe:starting:translate-x-full';
  }
  return layout === 'fullscreen'
    ? '@container fixed inset-x-0 top-[var(--phone-dialog-top,0)] z-40 flex h-[var(--phone-dialog-height,100dvh)] min-w-0 w-full flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground outline-none'
    : layout === 'page'
      ? '@container flex h-full min-h-0 min-w-0 w-full overflow-hidden bg-background text-foreground outline-none'
      : '@container flex h-[calc(100dvh-var(--spacing)*36)] max-h-192 min-w-0 w-128 max-w-full flex-col overflow-hidden rounded-lg border border-divider bg-background text-foreground shadow-lg outline-none';
}
