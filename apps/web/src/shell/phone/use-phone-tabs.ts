import { isChatTabId, type OpenTab } from '@nix/web-foundation/lib/tab-store';
import { useDocumentTabs } from '../../tabs/use-document-tabs';

/** The open documents of the one phone pane: the existing tab state, minus chats and the empty id. */
export function usePhoneTabs(selectedId: string | null): readonly OpenTab[] {
  const { tabs } = useDocumentTabs(0, selectedId ?? '');
  return tabs.filter((tab) => tab.itemId !== '' && !isChatTabId(tab.itemId));
}
