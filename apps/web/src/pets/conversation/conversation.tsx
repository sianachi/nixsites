// The conversation with the pet - header, messages, composer and the settings and history
// sub-panels - kept apart from the floating launcher in `pet-companion.tsx` so a page can render
// the same conversation without the launcher, the drag handling or the panel positioning. How it
// sits on screen is the caller's `layout`; everything inside is the same in all of them.
import { type PetProfile, type PetSettings } from '@nix/api-client';
import { Button, Text, focusRing } from '@nix/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiClient } from '../../api/api-client-provider';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { usePaneIndex } from '../../panes/pane-context';
import { selectedItemParam } from '../../panes/pane-params';
import { NewChatNote } from '../../views/chat/new-chat-note';
import { SaveInsightNote } from '../../views/chat/save-insight-note';
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
import { useTurns } from './state/use-turns';

type ConversationPanel = 'chat' | 'settings' | 'history';

/** How the conversation sits on screen. `floating` is the bordered panel beside the launcher;
 * `fullscreen` is the fixed phone dialog that covers the page; `page` fills whatever parent it is
 * given, with no border, no fixed positioning and no scroll lock. */
export type ConversationLayout = 'floating' | 'fullscreen' | 'page';

export interface ConversationProps {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly layout: ConversationLayout;
  readonly runtimeApi: UsePetRuntimeResult;
  readonly onNeedsDecisionChange: (toolIds: readonly string[]) => void;
  readonly noteScope?: {
    readonly rootItemId: string;
    readonly title: string;
    readonly readOnly: boolean;
    readonly onReadOnlyChange: (readOnly: boolean) => void;
  };
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
  const [model, setModel] = useState(() =>
    readConversationModel(workspaceId, pet.id, pet.provider),
  );
  const [workspaceAccessPreference, setWorkspaceAccess] = useState(() =>
    readWorkspaceAccess(workspaceId, pet.id),
  );
  const workspaceAccess = noteScope !== undefined || workspaceAccessPreference;
  const [readWithoutAsking, setReadWithoutAsking] = useState(() => readReadWithoutAsking());
  const [needsDecisionIds, setNeedsDecisionIds] = useState<readonly string[]>([]);
  // The last user message, being edited in place: its id pins the edit to that message.
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | null>(
    null,
  );
  const input = useRef<HTMLTextAreaElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  // Must-fix 7: `Text` deliberately takes no `ref`/`tabIndex` (its own contract refuses an open
  // prop spread), so the focus target on open is a plain wrapper around the visible `<h3>` -
  // still announced as a level-3 heading, just not itself the tab stop.
  const panelHeading = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<{ current: HTMLButtonElement | null } | null>(null);
  const messages = runtime?.messages ?? [];
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
  function closeEditor() {
    setEditing(null);
    input.current?.focus();
  }

  const context = useMessageContext({ currentItem, noteScope, workspaceAccess });
  const { submit, resendTurn, retryLastTurn, retryLabel, retryError, loadErrorMessage } = useTurns({
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
  });

  const rename = useRename({
    workspaceId,
    petId: pet.id,
    rootItemId: noteScope?.rootItemId,
    setRuntime,
  });

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
    inactive: busy || running,
    onSaveChat: () => {
      setSaveChat(true);
    },
    onNewConversation: () => {
      context.setAutoPageOff(false);
      void reset();
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

  const suggestions = petSuggestions(Boolean(currentItem));
  const slash = useSlashMenu(draft, suggestions, pickSuggestion);

  /** A generated-UI button's request: filled in, never sent, so the owner reads what a component
   * asks for (it may be a change) before the pet sees it. */
  function askFromComponent(text: string) {
    setDraft(text);
    input.current?.focus();
  }

  /** An action from the empty state or the slash menu: it fills the composer, and "Summarize
   * this page" also attaches the open page. */
  function pickSuggestion(suggestion: string) {
    setDraft(suggestion);
    if (suggestion === 'Summarize this page') context.attachPageContext();
    regenerateRequestId();
    input.current?.focus();
  }

  if (noteScope && !runtime && error) {
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

  return (
    <div
      ref={dialog}
      role="dialog"
      tabIndex={-1}
      aria-modal={fullscreen}
      aria-label={`Conversation with ${pet.name}`}
      className={dialogClass(layout)}
    >
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
        motion={settings.motion}
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
        locked={running || busy}
      />
      {panel === 'settings' ? (
        <PetSettingsPanel
          pet={pet}
          workspaceId={workspaceId}
          model={model}
          models={models}
          running={running || busy}
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
          running={running || busy}
          onResumed={(resumed) => {
            setRuntime(resumed);
            goBackFromPanel();
          }}
        />
      ) : !runtime ? (
        // Must-fix 11/12: while nothing has ever loaded yet, the body says so plainly instead of
        // showing the empty-state suggestions as if the conversation were simply quiet - and once
        // a load error shows up here, it replaces the "Loading" text rather than sitting beside it.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
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
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {pet.provider === 'chatgpt' ? (
            <PetConnectionPanel />
          ) : (
            <div className="flex flex-col gap-3">
              <Text role="alert">
                {runtime.reason ||
                  `Set up ${petProviderLabels[pet.provider]} in Pet settings to chat.`}
              </Text>
              <Link to={`/w/${workspaceId}/settings?tab=pets`} className={`underline ${focusRing}`}>
                <Text as="span">Open Pet settings</Text>
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
          />
          {error ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-divider px-3 py-2 @sm:px-4">
              <Text role="alert">{errorKind === 'load' ? loadErrorMessage : error}</Text>
              {error && retryLabel() ? (
                <Button variant="ghost" onClick={retryError}>
                  {retryLabel()}
                </Button>
              ) : null}
            </div>
          ) : null}
          <Composer
            petName={pet.name}
            input={input}
            draft={draft}
            onDraftChange={(text) => {
              setDraft(text);
              regenerateRequestId();
            }}
            touchLikeComposer={touchLikeComposer}
            slash={slash}
            onSubmit={() => void submit()}
            onInterrupt={() => void interrupt()}
            running={running}
            canSend={!busy && Boolean(draft.trim()) && connected}
            chips={context.chips}
            onRemoveChip={context.removeContext}
            needsWorkspaceAccess={context.contexts.length > 0 && !workspaceAccess}
            onTurnOnWorkspaceAccess={() => {
              setWorkspaceAccess(true);
              writeWorkspaceAccess(workspaceId, pet.id, true);
            }}
            workspaceAccess={workspaceAccess}
            hasNoteScope={noteScope !== undefined}
            noteReadOnly={noteScope?.readOnly ?? false}
            onToggleWorkspaceAccess={() => {
              const next = !workspaceAccess;
              setWorkspaceAccess(next);
              writeWorkspaceAccess(workspaceId, pet.id, next);
              // Nothing can be applied without workspace tools, so the switch goes with it.
              if (!next) setApplyWithoutAsking(false);
            }}
            applyWithoutAsking={applyWithoutAsking}
            onApplyChange={setApplyWithoutAsking}
            hasPage={Boolean(currentItem)}
            contextCount={context.contexts.length}
            hasSelection={context.hasSelection}
            onAttachPage={context.attachPageContext}
            onShareSelection={context.shareSelection}
          />
        </>
      )}
    </div>
  );
}

function dialogClass(layout: 'floating' | 'fullscreen' | 'page'): string {
  return layout === 'fullscreen'
    ? '@container fixed inset-x-0 top-[var(--phone-dialog-top,0)] z-40 flex h-[var(--phone-dialog-height,100dvh)] min-w-0 w-full flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground outline-none'
    : layout === 'page'
      ? '@container flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background text-foreground outline-none'
      : '@container flex h-[calc(100dvh-var(--spacing)*36)] max-h-192 min-w-0 w-128 max-w-full flex-col overflow-hidden rounded-lg border border-divider bg-background text-foreground shadow-lg outline-none';
}
