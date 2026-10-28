import { readLastWorkspaceId } from './last-workspace';
import { conversations, type Conversation } from '@nix/api-client';
import { useApiClient } from '../api/api-client-provider';
import { Button, Input, Text, focusRing } from '@nix/ui';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { addGroup } from './arrangement';
import { useAccessibleWorkspaces } from './workspace-context';
import { useWorkspaceArrangement } from './use-workspace-arrangement';
import { WorkspaceGroupsSection } from './workspace-groups-section';

export function LegacyWorkspaceGroupRedirect(): ReactNode {
  const { groupId = '' } = useParams();
  return <Navigate replace to={`/workspaces/groups/${encodeURIComponent(groupId)}`} />;
}

export function WorkspaceGroupsPage(): ReactNode {
  const { arrangement, loading, saving, error, save } = useWorkspaceArrangement();
  const [name, setName] = useState('');
  return (
    <main className={`${paneScroller} mx-auto flex w-full max-w-4xl flex-col gap-6 p-6`}>
      <BackToWorkspace />
      <Text as="h1" variant="h3">
        Workspace groups
      </Text>
      <Text tone="muted">
        Organize your workspaces and explore them together with your pets. Groups are personal and
        do not grant access.
      </Text>
      {error ? <Text role="alert">{error}</Text> : null}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save(addGroup(arrangement, name)).then((ok) => {
            if (ok) setName('');
          });
        }}
      >
        <Input
          aria-label="New group name"
          value={name}
          maxLength={80}
          onChange={(event) => {
            setName(event.currentTarget.value);
          }}
        />
        <Button type="submit" disabled={loading || saving || !name.trim()}>
          Create group
        </Button>
      </form>
      {loading ? (
        <Text role="status">Loading groups…</Text>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Open workspace group">
          {arrangement.groups.map((group) => (
            <li key={group.id}>
              <Link
                className={`text-accent-text underline ${focusRing}`}
                to={`/workspaces/groups/${group.id}`}
              >
                {group.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <WorkspaceGroupsSection headingLevel="h2" />
    </main>
  );
}

// New-chat lives in views/, which sits above workspaces/, so the route passes it in.
export function WorkspaceGroupPage({
  NewChatNote,
}: {
  readonly NewChatNote: ComponentType<{
    readonly groupId: string;
    readonly sourceWorkspaceIds: readonly string[];
    readonly initialPrompt: string;
    readonly onClose: () => void;
  }>;
}): ReactNode {
  const { groupId = '' } = useParams();
  const { workspaces, status } = useAccessibleWorkspaces();
  const { arrangement, loading, error } = useWorkspaceArrangement();
  const [tab, setTab] = useState<'Overview' | 'Chats' | 'Manage'>('Overview');
  const [prompt, setPrompt] = useState<string | null>(null);
  const group = arrangement.groups.find((entry) => entry.id === groupId);
  const members = workspaces.filter(
    (entry) => entry.lifecycleState === 'active' && group?.workspaceIds.includes(entry.id),
  );
  return (
    <main className={`${paneScroller} mx-auto flex w-full max-w-4xl flex-col gap-6 p-6`}>
      <Link className={`text-accent-text underline ${focusRing}`} to="/workspaces/groups">
        All workspace groups
      </Link>
      <Text as="h1" variant="h3">
        {group?.name ?? 'Workspace group'}
      </Text>
      {loading ? (
        <Text role="status">Loading group…</Text>
      ) : error ? (
        <Text role="alert">{error}</Text>
      ) : !group ? (
        <Text role="status">This workspace group no longer exists.</Text>
      ) : (
        <>
          <nav aria-label="Group sections" className="flex gap-2">
            {(['Overview', 'Chats', 'Manage'] as const).map((name) => (
              <Button
                key={name}
                variant={tab === name ? 'primary' : 'secondary'}
                aria-current={tab === name ? 'page' : undefined}
                onClick={() => {
                  setTab(name);
                }}
              >
                {name}
              </Button>
            ))}
          </nav>
          {tab === 'Manage' ? (
            <WorkspaceGroupsSection key={groupId} groupId={groupId} />
          ) : (
            <>
              <Button
                disabled={!members.length || status === 'loading'}
                onClick={() => {
                  setPrompt('');
                }}
              >
                New chat
              </Button>
              {tab === 'Overview' ? (
                <>
                  <Text as="h2" variant="h4">
                    Workspaces
                  </Text>
                  {!members.length ? (
                    <Text>No accessible workspaces in this group. Add workspaces in Manage.</Text>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {members.map((entry) => (
                        <li key={entry.id}>
                          <Link
                            className={`text-accent-text underline ${focusRing}`}
                            to={`/w/${entry.id}`}
                          >
                            {entry.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {['Compare priorities', 'Summarize recent work'].map((text) => (
                      <Button
                        variant="secondary"
                        disabled={!members.length}
                        key={text}
                        onClick={() => {
                          setPrompt(text);
                        }}
                      >
                        {text}
                      </Button>
                    ))}
                  </div>
                </>
              ) : null}
              <Text as="h2" variant="h4">
                Saved chats
              </Text>
              <GroupSavedChats itemIds={group.conversationItemIds ?? []} />
            </>
          )}
          {prompt !== null ? (
            <NewChatNote
              groupId={groupId}
              sourceWorkspaceIds={members.map((entry) => entry.id)}
              initialPrompt={prompt}
              onClose={() => {
                setPrompt(null);
              }}
            />
          ) : null}
        </>
      )}
    </main>
  );
}

function GroupSavedChats({ itemIds }: { readonly itemIds: readonly string[] }): ReactNode {
  const client = useApiClient();
  const [chats, setChats] = useState<readonly Conversation[]>([]);
  const [failed, setFailed] = useState(false);
  const ids = itemIds.join(',');
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled(
      (ids ? ids.split(',') : []).map((id) =>
        client.query(conversations.conversation(id), { signal: controller.signal }),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setChats(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])));
      setFailed(results.some((result) => result.status === 'rejected'));
    });
    return () => {
      controller.abort();
    };
  }, [client, ids]);
  return (
    <>
      {failed ? <Text role="status">Some chats are unavailable.</Text> : null}
      {!chats.length ? (
        <Text tone="muted">No saved chats to show.</Text>
      ) : (
        <ul className="flex flex-col gap-2">
          {chats.map((chat) => (
            <li key={chat.itemId}>
              <Link
                className={`text-accent-text underline ${focusRing}`}
                to={`/w/${chat.workspaceId}?item=${chat.itemId}`}
              >
                {chat.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function BackToWorkspace(): ReactNode {
  const { workspaces } = useAccessibleWorkspaces();
  const active = workspaces.filter((entry) => entry.lifecycleState === 'active');
  const remembered = readLastWorkspaceId();
  const destination = active.find((entry) => entry.id === remembered) ?? active[0];
  return destination ? (
    <Link className={`text-accent-text underline ${focusRing}`} to={`/w/${destination.id}`}>
      Back to {destination.name}
    </Link>
  ) : null;
}
