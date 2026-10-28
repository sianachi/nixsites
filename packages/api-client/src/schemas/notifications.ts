import { z } from 'zod';

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm.');

export const preferencesInputSchema = z.object({
  timeZone: z.string().min(1).max(64),
  quietStart: timeOfDay.nullable(),
  quietEnd: timeOfDay.nullable(),
  dueReminderTime: timeOfDay,
  dueReminders: z.boolean(),
  habitReminders: z.boolean(),
  mutedContainerIds: z.array(z.uuid()).max(200),
});

export const principalPreferencesResponseSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  timeZone: z.string(),
  quietStart: z.string().nullable(),
  quietEnd: z.string().nullable(),
  dueReminderTime: z.string(),
  dueReminders: z.boolean(),
  habitReminders: z.boolean(),
  mutedContainerIds: z.array(z.uuid()),
});

const notificationKindSchema = z.enum([
  'reminder',
  'automation',
  'calendar',
  'system',
  'invitation',
]);

const notificationDtoSchema = z.object({
  id: z.uuid(),
  kind: notificationKindSchema,
  title: z.string().max(200),
  body: z.string().max(1000),
  itemId: z.uuid().nullable(),
  workspaceId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  readAt: z.iso.datetime({ offset: true }).nullable(),
});

export const notificationsPageResponseSchema = z.object({
  items: z.array(notificationDtoSchema),
  nextCursor: z.string().nullable(),
  unread: z.number().int().min(0),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const notificationReadResponseSchema = z.object({
  unread: z.number().int().min(0),
});

export const pushSubscriptionDtoSchema = z.object({
  id: z.uuid(),
  endpoint: z.string().max(2048),
  userAgent: z.string().max(400),
  createdAt: z.iso.datetime({ offset: true }),
  lastSuccessAt: z.iso.datetime({ offset: true }).nullable(),
});

export const pushPublicKeyResponseSchema = z.object({
  publicKey: z.string().min(1),
});

export type PreferencesInput = z.infer<typeof preferencesInputSchema>;
export type PrincipalPreferencesResponse = z.infer<typeof principalPreferencesResponseSchema>;
export type NotificationDto = z.infer<typeof notificationDtoSchema>;
export type NotificationsPageResponse = z.infer<typeof notificationsPageResponseSchema>;
export type NotificationReadResponse = z.infer<typeof notificationReadResponseSchema>;
export type PushSubscriptionDto = z.infer<typeof pushSubscriptionDtoSchema>;
export type PushPublicKeyResponse = z.infer<typeof pushPublicKeyResponseSchema>;
