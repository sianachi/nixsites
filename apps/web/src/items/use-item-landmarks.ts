import { useCallback, useSyncExternalStore } from 'react';

import { useSessionStore } from '../lib/session-store';
import { useWorkspace } from '../workspaces/workspace-context';
import { publishNotice } from '../lib/notices';
import {
  emptyItemLandmarks,
  itemLandmarksKey,
  readItemLandmarks,
  subscribeItemLandmarks,
  writeItemLandmark,
  type ItemLandmark,
  type ItemLandmarks,
} from '../lib/item-landmarks';

interface ItemLandmarksPreference {
  readonly scope: string | null;
  readonly enabled: boolean;
  readonly landmarks: ItemLandmarks;
  readonly save: (itemId: string, landmark: ItemLandmark | null) => void;
}

export function useItemLandmarks(): ItemLandmarksPreference {
  const subject = useSessionStore((state) => state.profile?.subject ?? null);
  const { workspaceId } = useWorkspace();
  const scope = subject === null ? null : itemLandmarksKey(subject, workspaceId);
  const snapshot = useCallback(
    () => (scope === null ? emptyItemLandmarks() : readItemLandmarks(scope)),
    [scope],
  );
  const landmarks = useSyncExternalStore(subscribeItemLandmarks, snapshot, emptyItemLandmarks);
  return {
    scope,
    enabled: scope !== null,
    landmarks,
    save: (itemId: string, landmark: ItemLandmark | null): void => {
      if (scope === null) return;
      if (
        landmark !== null &&
        landmarks[itemId] === undefined &&
        Object.keys(landmarks).length >= 2000
      ) {
        publishNotice({
          key: 'item-landmark',
          message:
            'This browser already has 2,000 item icons in this workspace. Reset an icon before adding another.',
        });
        return;
      }
      const retained = writeItemLandmark(scope, itemId, landmark);
      publishNotice({
        key: 'item-landmark',
        message: retained
          ? 'Item icon updated in this browser.'
          : 'Item icon updated for this page. Your browser could not save it; it lasts until this page reloads.',
      });
    },
  };
}
