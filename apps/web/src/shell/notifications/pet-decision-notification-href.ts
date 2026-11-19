import type { NotificationDto } from '@nix/api-client';

import { petJobHref } from '../../pages/editor/pet-job-routing';

export function petDecisionNotificationHref(notification: NotificationDto): string | null {
  const { itemId, workspaceId, petDecision } = notification;
  return itemId !== null && workspaceId !== null && petDecision != null
    ? petJobHref(workspaceId, itemId, petDecision.runId, petDecision.decisionId)
    : null;
}
