import { MessagesSquare } from 'lucide-react';
import type { ReactNode } from 'react';

import { Text } from '@nix/ui';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { ViewKindDescriptor, ViewRendererProps } from '../../views/core/view-kinds';
import { ChatView } from './chat-view';

function ChatRenderer({ container }: ViewRendererProps): ReactNode {
  const { workspaceId } = useWorkspace();
  return container.itemId === null ? (
    <Text role="status">Create a chat note to start a conversation.</Text>
  ) : (
    <ChatView
      key={`${workspaceId}:${container.itemId}`}
      itemId={container.itemId}
      workspaceId={workspaceId}
    />
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
