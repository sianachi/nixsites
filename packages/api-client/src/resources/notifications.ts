import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import type { components } from '../generated/api.js';
import { noContentSchema } from '../schemas/index.js';
import {
  principalPreferencesResponseSchema,
  notificationsPageResponseSchema,
  notificationReadResponseSchema,
  pushSubscriptionDtoSchema,
  pushPublicKeyResponseSchema,
  type PreferencesInput,
  type PrincipalPreferencesResponse,
  type NotificationsPageResponse,
  type NotificationReadResponse,
  type PushSubscriptionDto,
  type PushPublicKeyResponse,
} from '../schemas/notifications.js';

const preferencesKey = ['me', 'preferences'] as const;
const notificationsKey = ['me', 'notifications'] as const;
const pushSubscriptionsKey = ['me', 'push-subscriptions'] as const;

export const preferences = (): QueryEndpoint<PrincipalPreferencesResponse> =>
  defineQuery({
    operation: 'notifications.preferences',
    path: '/api/v1/me/preferences',
    schema: principalPreferencesResponseSchema,
    cacheKey: preferencesKey,
  });

export const savePreferences = (
  expectedRevision: number,
  value: PreferencesInput,
): CommandEndpoint<PrincipalPreferencesResponse> =>
  defineCommand({
    operation: 'notifications.savePreferences',
    method: 'PUT',
    path: '/api/v1/me/preferences',
    schema: principalPreferencesResponseSchema,
    body: {
      expectedRevision,
      preferences: value,
    } satisfies components['schemas']['SavePreferencesRequest'],
    invalidates: [preferencesKey],
  });

export interface ListNotificationsInput {
  readonly cursor?: string;
  readonly unreadOnly?: boolean;
}

export const list = (
  input: ListNotificationsInput = {},
): QueryEndpoint<NotificationsPageResponse> =>
  defineQuery({
    operation: 'notifications.list',
    path: '/api/v1/me/notifications',
    schema: notificationsPageResponseSchema,
    query: {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.unreadOnly ? { unreadOnly: input.unreadOnly } : {}),
    },
    cacheKey: [...notificationsKey, input.cursor ?? '', String(input.unreadOnly ?? false)],
  });

export const markRead = (notificationId: string): CommandEndpoint<NotificationReadResponse> =>
  defineCommand({
    operation: 'notifications.markRead',
    method: 'POST',
    path: `/api/v1/me/notifications/${notificationId}/read`,
    schema: notificationReadResponseSchema,
    invalidates: [notificationsKey],
  });

export const markAllRead = (): CommandEndpoint<NotificationReadResponse> =>
  defineCommand({
    operation: 'notifications.markAllRead',
    method: 'POST',
    path: '/api/v1/me/notifications/read-all',
    schema: notificationReadResponseSchema,
    invalidates: [notificationsKey],
  });

export interface WatchNotificationsInput {
  /** The caller's last known revision; the server waits for a change past it. */
  readonly after?: number;
}

/**
 * The GET long-poll counterpart to `list`: never a write, never rate limited by the writes
 * policy, and never de-duplicated the way a cached query would be, since each call carries a
 * different `after`. The server bounds how many of these one principal may hold open at once.
 */
export const watch = (
  input: WatchNotificationsInput = {},
): QueryEndpoint<NotificationsPageResponse> =>
  defineQuery({
    operation: 'notifications.watch',
    retain: false,
    path: '/api/v1/me/notifications/watch',
    schema: notificationsPageResponseSchema,
    query: {
      after: input.after ?? 0,
    },
  });

export const addPushSubscription = (
  endpoint: string,
  p256dh: string,
  auth: string,
): CommandEndpoint<PushSubscriptionDto> =>
  defineCommand({
    operation: 'notifications.addPushSubscription',
    method: 'POST',
    path: '/api/v1/me/push-subscriptions',
    schema: pushSubscriptionDtoSchema,
    body: { endpoint, p256dh, auth } satisfies components['schemas']['AddPushSubscriptionRequest'],
    invalidates: [pushSubscriptionsKey],
  });

export const removePushSubscription = (endpoint: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'notifications.removePushSubscription',
    method: 'DELETE',
    path: '/api/v1/me/push-subscriptions',
    schema: noContentSchema,
    body: { endpoint } satisfies components['schemas']['RemovePushSubscriptionRequest'],
    invalidates: [pushSubscriptionsKey],
  });

export const pushPublicKey = (): QueryEndpoint<PushPublicKeyResponse> =>
  defineQuery({
    operation: 'notifications.pushPublicKey',
    path: '/api/v1/me/push/public-key',
    schema: pushPublicKeyResponseSchema,
    cacheKey: ['me', 'push', 'public-key'],
  });
