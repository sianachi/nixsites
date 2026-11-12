import { items, locks, type Item, type PetProfile, type PetSettings } from '@nix/api-client';
import { Dialog, Text, focusRing } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';
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
import { Conversation } from '@nix/web-pets/pets/conversation/conversation';
import { usePetRuntime } from '@nix/web-pets/pets/use-pet-runtime';
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

export function NoteChatDrawer({
  workspaceId,
  rootItemId,
  onClose,
}: {
  readonly workspaceId: string;
  readonly rootItemId: string;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open
      title="Chat about this note"
      closeLabel="Close note chat"
      onClose={onClose}
      presentation="workspace"
      className="rounded-none sm:ml-auto sm:mr-0 sm:mb-auto sm:mt-[var(--sheet-viewport-top,0%)] sm:h-[var(--sheet-viewport-height,100dvh)] sm:w-128 sm:max-w-full motion-safe:transition-transform motion-safe:duration-200 motion-safe:starting:translate-x-full"
    >
      <PetConversationPane workspaceId={workspaceId} rootItemId={rootItemId} />
    </Dialog>
  );
}

/** One conversation - the workspace's, or a note's - with the checks that it can be had at all. */
export function PetConversationPane({
  workspaceId,
  rootItemId,
}: {
  readonly workspaceId: string;
  readonly rootItemId: string | null;
}): ReactElement {
  const { saved, loading, error } = usePetSettings();
  const pet = saved?.settings.profiles.find((profile) => profile.id === saved.settings.activePetId);
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
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly rootItemId: string | null;
}): ReactElement {
  if (rootItemId !== null) {
    if (!z.uuid().safeParse(rootItemId).success)
      return (
        <ErrorPanel title="This note could not be opened" detail="The note address is invalid." />
      );
    return (
      <NoteChatPane
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
      <Conversation
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

function NoteChatPane({
  workspaceId,
  pet,
  settings,
  rootItemId,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly rootItemId: string;
}): ReactElement {
  const client = useApiClient();
  const [root, setRoot] = useState<Item | null>(null);
  const [error, setError] = useState('');
  const [readOnly, setReadOnly] = useState(true);
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
      workspaceId={workspaceId}
      pet={pet}
      settings={settings}
      root={root}
      readOnly={readOnly}
      onReadOnlyChange={setReadOnly}
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
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly root: Item;
  readonly readOnly: boolean;
  readonly onReadOnlyChange: (readOnly: boolean) => void;
}): ReactElement {
  const runtimeApi = usePetRuntime(workspaceId, pet.id, true, root.id);
  return (
    <div className={paneColumn}>
      <Text variant="h1" as="h1" className="sr-only">
        Chat about {root.title}
      </Text>
      <Conversation
        workspaceId={workspaceId}
        pet={pet}
        settings={settings}
        layout="page"
        runtimeApi={runtimeApi}
        noteScope={{ rootItemId: root.id, title: root.title, readOnly, onReadOnlyChange }}
        onNeedsDecisionChange={ignoreDecisions}
      />
    </div>
  );
}
