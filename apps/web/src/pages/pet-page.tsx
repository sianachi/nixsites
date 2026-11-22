import { items, locks, type Item, type PetProfile, type PetSettings } from '@nix/api-client';
import { Dialog, Text, cn, focusRing } from '@nix/ui';
import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
} from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { paneColumn } from '@nix/web-foundation/layout/regions';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { chatTabId, useTabStore } from '@nix/web-foundation/lib/tab-store';
import type { ConversationProps } from '@nix/web-pets/pets/conversation/conversation';
import { usePaneIndex } from '@nix/web-platform/panes/pane-context';
import { selectedItemParam } from '@nix/web-platform/panes/pane-params';
import { PetCanvasReviewLayout, PetCanvasReviewPane } from '../panel/pet-canvas-review';
import { usePetDialogJobs } from '../panel/pet-runs-section';
import { usePetRunFeed } from '../panel/use-pet-run-feed';
import { petJobHref } from './editor/pet-job-routing';
import { bodyNoun } from './editor/lock-copy';
import { useActivePetItemDialog, usePetItemDialogOwner } from './editor/pet-dialog-owner';
import { usePetRuntime } from '@nix/web-pets/pets/use-pet-runtime';
import { PetCompanion } from '@nix/web-pets/pets/pet-companion';
import { usePetSettings } from '@nix/web-platform/api/use-pet-settings';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';

// On this page nothing sits behind a launcher, so there is no badge for a decision to set.
function ignoreDecisions(): void {
  /* Approvals are shown inside the conversation itself. */
}

/**
 * The pet destination: the same conversation as the floating panel, given the whole pane.
 *
 * The conversation lives on the server, so this is not a second chat but a second place to see
 * the one that exists. `PetCompanion` renders nothing while this route is current, which is what
 * keeps a single runtime (and a single `PetWorkTools`) alive at a time.
 *
 * A note's conversation (`?root=`) belongs in a tab where tabs are drawn, so on a wide window this
 * hands it to the editor; a narrow window or Zen keeps it here.
 */
// The conversation (messages, tools, generated UI) is the heaviest part of the companion and is
// only drawn once someone opens it, so it loads on that first open instead of with the shell.
const Conversation = lazy(async () => ({
  default: (await import('@nix/web-pets/pets/conversation/conversation')).Conversation,
}));

export function PetPage(): ReactElement {
  const { workspaceId } = useWorkspace();
  const [search] = useSearchParams();
  const rootItemId = search.get('root');
  const narrow = useNarrowViewport();
  const zen = useZenActive();
  const tabsDrawn = !narrow && !zen;
  if (tabsDrawn && rootItemId !== null && z.uuid().safeParse(rootItemId).success) {
    return <ChatTabRedirect workspaceId={workspaceId} rootItemId={rootItemId} />;
  }
  return <PetConversationPane workspaceId={workspaceId} rootItemId={rootItemId} />;
}

/** Opens the note conversation as the only pane's chat tab, replacing the page in history. */
function ChatTabRedirect({
  workspaceId,
  rootItemId,
}: {
  readonly workspaceId: string;
  readonly rootItemId: string;
}): ReactElement {
  const itemOpenedAlone = useTabStore((state) => state.itemOpenedAlone);
  const tabPinned = useTabStore((state) => state.tabPinned);
  useEffect(() => {
    itemOpenedAlone(rootItemId, true);
    tabPinned(0, chatTabId(rootItemId));
  }, [itemOpenedAlone, tabPinned, rootItemId]);
  return (
    <Navigate
      replace
      to={`/w/${encodeURIComponent(workspaceId)}?item=${rootItemId}&chat=${rootItemId}`}
    />
  );
}

interface ActivePetJob {
  readonly activeRunId?: string | undefined;
  readonly activeDecisionId?: string | undefined;
  readonly onViewComment?: ((threadId: string) => void) | undefined;
  readonly onItemRefresh?: ((item: Item) => void) | undefined;
}

export function NoteChatDrawer({
  workspaceId,
  rootItemId,
  itemNoun = 'note',
  activeRunId,
  activeDecisionId,
  onViewComment,
  onItemRefresh,
  onClose,
}: ActivePetJob & {
  readonly workspaceId: string;
  readonly rootItemId: string;
  readonly itemNoun?: string;
  readonly onClose: () => void;
}): ReactElement {
  const ownsConversation = usePetItemDialogOwner(rootItemId);
  return (
    <PetCanvasReviewLayout>
      {(reviewOpen, closeReview) => (
        <Dialog
          open
          title={`Chat about this ${itemNoun}`}
          closeLabel={reviewOpen ? 'Close drawing review' : `Close ${itemNoun} chat`}
          onClose={reviewOpen ? closeReview : onClose}
          presentation="workspace"
          className={cn(
            'rounded-none sm:mr-0 sm:mb-auto sm:mt-[var(--sheet-viewport-top,0%)] sm:h-[var(--sheet-viewport-height,100dvh)] sm:max-w-full motion-safe:transition-transform motion-safe:duration-200 motion-safe:starting:translate-x-full',
            reviewOpen ? 'sm:ml-auto sm:w-full sm:max-w-6xl' : 'sm:ml-auto sm:w-128',
          )}
        >
          <div className="flex min-h-0 min-w-0 flex-1">
            <PetCanvasReviewPane className="flex-1 sm:border-e sm:border-divider" />
            <div
              className={cn(
                'flex min-h-0 min-w-0 flex-1 flex-col',
                reviewOpen && 'max-sm:hidden sm:max-w-128',
              )}
            >
              {ownsConversation ? (
                <PetConversationPane
                  workspaceId={workspaceId}
                  rootItemId={rootItemId}
                  activeRunId={activeRunId}
                  activeDecisionId={activeDecisionId}
                  onViewComment={onViewComment}
                  onItemRefresh={onItemRefresh}
                  inDialog
                />
              ) : null}
            </div>
          </div>
        </Dialog>
      )}
    </PetCanvasReviewLayout>
  );
}

/** One conversation - the workspace's, or a note's - with the checks that it can be had at all. */
export function PetConversationPane({
  workspaceId,
  rootItemId,
  inDialog = false,
  ...activeJob
}: ActivePetJob & {
  readonly workspaceId: string;
  readonly rootItemId: string | null;
  readonly inDialog?: boolean;
}): ReactElement | null {
  const activeItemDialog = useActivePetItemDialog();
  const { saved, loading, error } = usePetSettings();
  const pet = saved?.settings.profiles.find((profile) => profile.id === saved.settings.activePetId);
  if (!inDialog && rootItemId !== null && activeItemDialog?.itemId === rootItemId) return null;
  if (!saved) {
    return error ? (
      <ErrorPanel title="The companion could not be loaded" detail={error} />
    ) : (
      <LoadingPanel label={loading ? 'the companion' : 'the companion settings'} />
    );
  }
  if (!saved.settings.enabled || !pet) {
    return (
      <EmptyPanel
        title="The companion is switched off"
        detail="Turn it on in Settings to chat with it here."
        action={
          <Link to={`/w/${workspaceId}/settings?tab=pets`} className={`underline ${focusRing}`}>
            <Text as="span">Open Settings</Text>
          </Link>
        }
      />
    );
  }
  return (
    <ConversationScope
      {...activeJob}
      inDialog={inDialog}
      key={`${workspaceId}:${pet.id}:${pet.provider}:${rootItemId ?? ''}`}
      workspaceId={workspaceId}
      pet={pet}
      settings={saved.settings}
      rootItemId={rootItemId}
    />
  );
}

function ConversationScope({
  workspaceId,
  pet,
  settings,
  rootItemId,
  inDialog,
  ...activeJob
}: ActivePetJob & {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly rootItemId: string | null;
  readonly inDialog: boolean;
}): ReactElement {
  if (rootItemId !== null) {
    if (!z.uuid().safeParse(rootItemId).success)
      return (
        <ErrorPanel title="This note could not be opened" detail="The note address is invalid." />
      );
    return (
      <NoteChatPane
        {...activeJob}
        inDialog={inDialog}
        workspaceId={workspaceId}
        pet={pet}
        settings={settings}
        rootItemId={rootItemId}
      />
    );
  }
  return <WorkspaceChatPane workspaceId={workspaceId} pet={pet} settings={settings} />;
}

const structuredRequestState = z.object({
  structuredRequest: z.object({
    id: z.uuid(),
    parentId: z.uuid().nullable(),
    prompt: z.string().trim().min(1).max(2000),
    initialTitle: z.string().trim().min(1).max(240).optional(),
  }),
});

function WorkspaceChatPane({
  workspaceId,
  pet,
  settings,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
}): ReactElement {
  const runtimeApi = usePetRuntime(workspaceId, pet.id, true);
  const location = useLocation();
  const navigate = useNavigate();
  const state = structuredRequestState.safeParse(location.state);
  const request = state.success ? state.data.structuredRequest : null;
  const destination = request?.parentId
    ? `inside [the selected item](/w/${workspaceId}?item=${request.parentId})`
    : 'at the top of the workspace';
  return (
    <div className={paneColumn}>
      <Text variant="h1" as="h1" className="sr-only">
        {pet.name}
      </Text>
      <PetJobConversation
        workspaceId={workspaceId}
        pet={pet}
        settings={settings}
        layout="page"
        runtimeApi={runtimeApi}
        onNeedsDecisionChange={ignoreDecisions}
        {...(request
          ? {
              creationRequest: {
                id: request.id,
                text: [
                  `Create a structured item ${destination} in this workspace for the request below.`,
                  ...(request.initialTitle
                    ? [`Name it ${JSON.stringify(request.initialTitle)}.`]
                    : []),
                  'Use a built-in view when one fits. For a calculator or another interactive program, create a note, then add a custom view and make it the default.',
                  'Keep any changes within the requested destination. Link to the item when it is ready.',
                  '',
                  request.prompt,
                ].join('\n'),
                onStarted: () => {
                  void navigate(location.pathname + location.search, {
                    replace: true,
                    state: null,
                  });
                },
              },
            }
          : {})}
      />
    </div>
  );
}

function PetActivityLink({ workspaceId }: { readonly workspaceId: string }): ReactElement {
  return (
    <Link
      to={`/w/${workspaceId}/pet/activity`}
      className={`mx-3 mb-3 inline-flex w-fit underline ${focusRing}`}
    >
      <Text variant="note" as="span">
        Pet activity
      </Text>
    </Link>
  );
}

function NoteChatPane({
  workspaceId,
  pet,
  settings,
  rootItemId,
  inDialog,
  onItemRefresh,
  ...activeJob
}: ActivePetJob & {
  readonly inDialog: boolean;
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly rootItemId: string;
}): ReactElement {
  const client = useApiClient();
  const [root, setRoot] = useState<Item | null>(null);
  const [error, setError] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const pendingRefreshes = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const pending = pendingRefreshes.current;
    return () => {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, []);

  function refreshEditedItem(itemId: string): void {
    pendingRefreshes.current.get(itemId)?.abort();
    const controller = new AbortController();
    pendingRefreshes.current.set(itemId, controller);
    void client
      .query(items.itemById(itemId), { signal: controller.signal, forceRefresh: true })
      .then((item) => {
        if (controller.signal.aborted || item.workspaceId !== workspaceId) return;
        if (item.id === rootItemId) setRoot(item);
        onItemRefresh?.(item);
      })
      .catch(() => undefined)
      .finally(() => {
        if (pendingRefreshes.current.get(itemId) === controller)
          pendingRefreshes.current.delete(itemId);
      });
  }
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      client.query(items.itemById(rootItemId), { signal: controller.signal, forceRefresh: true }),
      client.query(locks.getItemLock(rootItemId), {
        signal: controller.signal,
        forceRefresh: true,
      }),
    ])
      .then(([item, lock]) => {
        if (controller.signal.aborted) return;
        if (item.workspaceId !== workspaceId || (lock.locked && lock.unlockedUntil === null)) {
          setError('Open and unlock this note in its workspace before chatting about it.');
          return;
        }
        setRoot(item);
        setError('');
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Open and unlock this note before chatting about it.');
      });
    return () => {
      controller.abort();
    };
  }, [client, workspaceId, rootItemId]);
  if (error) return <ErrorPanel title="This note is unavailable" detail={error} />;
  if (!root) return <LoadingPanel label="the note conversation" />;
  return (
    <LoadedNoteChat
      {...activeJob}
      inDialog={inDialog}
      workspaceId={workspaceId}
      pet={pet}
      settings={settings}
      root={root}
      readOnly={readOnly}
      onReadOnlyChange={setReadOnly}
      onItemChanged={refreshEditedItem}
    />
  );
}

function LoadedNoteChat({
  workspaceId,
  pet,
  settings,
  root,
  readOnly,
  onReadOnlyChange,
  onItemChanged,
  inDialog,
  ...activeJob
}: ActivePetJob & {
  readonly inDialog: boolean;
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly root: Item;
  readonly readOnly: boolean;
  readonly onReadOnlyChange: (readOnly: boolean) => void;
  readonly onItemChanged: (itemId: string) => void;
}): ReactElement {
  const runtimeApi = usePetRuntime(workspaceId, pet.id, true, root.id);
  const noun = bodyNoun(root.type);
  const kindLabel = noun.charAt(0).toUpperCase() + noun.slice(1);
  return (
    <div className={paneColumn}>
      <Text variant="h1" as="h1" className="sr-only">
        Chat about {root.title}
      </Text>
      <PetJobConversation
        {...activeJob}
        inDialog={inDialog}
        targetType={root.type}
        workspaceId={workspaceId}
        pet={pet}
        settings={settings}
        layout="page"
        runtimeApi={runtimeApi}
        noteScope={{
          rootItemId: root.id,
          title: root.title,
          kindLabel,
          readOnly,
          onReadOnlyChange,
        }}
        onNeedsDecisionChange={ignoreDecisions}
        onItemChanged={onItemChanged}
      />
    </div>
  );
}

interface JobTarget {
  readonly id: string;
  readonly title: string;
  readonly type: string;
}

function PetJobConversation({
  targetItem,
  targetType,
  activeRunId,
  activeDecisionId,
  onViewComment,
  onItemChanged,
  workspaceJobsEnabled = false,
  ...props
}: ConversationProps &
  ActivePetJob & {
    readonly targetItem?: JobTarget | undefined;
    readonly targetType?: string;
    readonly workspaceJobsEnabled?: boolean;
    readonly onItemChanged?: (itemId: string) => void;
  }): ReactElement {
  const pane = usePaneIndex();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const selected = z.uuid().safeParse(search.get(selectedItemParam(pane)));
  const itemId =
    props.noteScope?.rootItemId ?? targetItem?.id ?? (selected.success ? selected.data : null);
  const itemDialog = props.inDialog === true;
  const jobs = usePetDialogJobs({
    workspaceId: props.workspaceId,
    itemId,
    itemTitle: props.noteScope?.title ?? targetItem?.title,
    itemType: targetType ?? targetItem?.type,
    activeRunId,
    activeDecisionId,
    onViewComment,
    onItemChanged,
    ...(itemDialog
      ? {}
      : {
          showTimeline: false,
          onStartForItem: (run) => {
            props.onClose?.();
            void navigate(petJobHref(run.workspaceId, run.itemId, run.id));
          },
        }),
  });
  return (
    <Suspense fallback={<LoadingPanel label="the conversation" />}>
      <Conversation
        {...props}
        jobs={{
          ...jobs,
          ...(!itemDialog && (jobs.enabled || workspaceJobsEnabled)
            ? { options: <PetActivityLink workspaceId={props.workspaceId} /> }
            : {}),
        }}
      />
    </Suspense>
  );
}

export function PetJobCompanion({
  targetItem,
  dock,
}: Pick<NonNullable<ComponentProps<typeof PetCompanion>>, 'dock'> & {
  readonly targetItem?: JobTarget | undefined;
}): ReactElement {
  const { workspaceId } = useWorkspace();
  const activeItemDialog = useActivePetItemDialog();
  const { feed } = usePetRunFeed('workspace', workspaceId);
  const jobsNeedDecision =
    feed.status === 'ready' &&
    feed.data.enabled &&
    feed.data.runs.some(
      (run) => run.status === 'waiting_for_input' || run.status === 'waiting_for_approval',
    );
  return (
    <PetCompanion
      dock={dock}
      suspendDialog={activeItemDialog !== null}
      jobsNeedDecision={jobsNeedDecision}
      dialog={(props) => (
        <PetJobConversation
          {...props}
          targetItem={targetItem}
          workspaceJobsEnabled={feed.status === 'ready' && feed.data.enabled}
        />
      )}
    />
  );
}
