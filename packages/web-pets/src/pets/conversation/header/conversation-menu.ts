import { type PetConnection } from '@nix/api-client';
import { type MenuEntry } from '@nix/ui';
import { Maximize2 } from 'lucide-react';
import { exportPetMessages } from '../../pet-history';

/** The conversation's More menu (also the header's context menu). */
export function conversationMenuItems({
  workspaceId,
  petName,
  openNoteId,
  layout,
  messages,
  inactive,
  onSaveChat,
  onNewConversation,
  onRename,
  onHistory,
  onReload,
  onOpenAsPage,
  onSettings,
}: {
  readonly workspaceId: string;
  readonly petName: string;
  /** The note a note chat is about, offered as "Open note". */
  readonly openNoteId: string | undefined;
  readonly layout: string;
  readonly messages: NonNullable<PetConnection['messages']>;
  /** A turn is running or a request is in flight. */
  readonly inactive: boolean;
  readonly onSaveChat: () => void;
  readonly onNewConversation: () => void;
  readonly onRename: () => void;
  readonly onHistory: () => void;
  readonly onReload: () => void;
  readonly onOpenAsPage: (() => void) | undefined;
  readonly onSettings: () => void;
}): MenuEntry[] {
  return [
    ...(openNoteId
      ? [
          {
            kind: 'link' as const,
            label: 'Open note',
            href: `/w/${workspaceId}?item=${openNoteId}`,
          },
          { kind: 'separator' as const },
        ]
      : []),
    { label: 'Save as chat note', disabled: inactive || !messages.length, onSelect: onSaveChat },
    { label: 'New conversation', disabled: inactive, onSelect: onNewConversation },
    {
      label: 'Rename conversation',
      disabled: inactive || !messages.length,
      onSelect: onRename,
    },
    { label: 'Past conversations', onSelect: onHistory },
    {
      label: 'Export conversation',
      disabled: !messages.length,
      onSelect: () => {
        exportPetMessages(messages, petName);
      },
    },
    { label: 'Reload conversation', onSelect: onReload },
    ...(layout === 'floating' && onOpenAsPage
      ? [{ label: 'Open as page', icon: Maximize2, onSelect: onOpenAsPage }]
      : []),
    { kind: 'separator' },
    { label: 'Chat settings', onSelect: onSettings },
    { kind: 'link', label: 'Pet settings', href: `/w/${workspaceId}/settings?tab=pets` },
  ];
}
