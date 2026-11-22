import { MessagesSquare } from 'lucide-react';
import { Suspense, lazy, type ReactNode } from 'react';

import { Text } from '@nix/ui';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { ViewKindDescriptor, ViewRendererProps } from '@nix/web-views/core/view-kinds';

// The chat view carries the message renderer and its generated-UI runtime, so it loads when a
// chat note is opened, as the custom view does.
const ChatView = lazy(async () => ({ default: (await import('./chat-view')).ChatView }));

function ChatRenderer({ container }: ViewRendererProps): ReactNode {
  const { workspaceId } = useWorkspace();
  return container.itemId === null ? (
    <Text role="status">Create a chat note to start a conversation.</Text>
  ) : (
    <Suspense fallback={<Text role="status">Loading the chat…</Text>}>
      <ChatView
        key={`${workspaceId}:${container.itemId}`}
        itemId={container.itemId}
        workspaceId={workspaceId}
      />
    </Suspense>
  );
}

export const CHAT_VIEW_KIND: ViewKindDescriptor = {
  kind: 'chat',
  label: 'Chat',
  icon: MessagesSquare,
  render: (props) => <ChatRenderer {...props} />,
  configures: [],
  chooses: [],
};
