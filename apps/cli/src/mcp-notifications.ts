import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notifications } from '@nix/api-client';
import {
  executeListNotifications,
  executeReadAllNotifications,
  executeReadNotification,
  executeSetPreferences,
  parsePreferenceFlags,
} from './commands/notifications.ts';
import { executeClearReminder, executeSetReminder } from './commands/reminders.ts';
import { executeProtect } from './commands/protection.ts';
import { identifier, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerNotificationAndReminderTools(
  server: McpServer,
  { session }: McpToolDeps,
): void {
  server.registerTool(
    'list_notifications',
    {
      description: 'List one page of your own notifications, newest first, with the unread count.',
      inputSchema: {
        unreadOnly: z.boolean().default(false),
        cursor: z.string().max(512).optional(),
      },
    },
    ({ unreadOnly, cursor }) =>
      toolResult(async () =>
        executeListNotifications(await session(), { unread: unreadOnly, cursor }),
      ),
  );

  server.registerTool(
    'mark_notification_read',
    {
      description: 'Mark one of your notifications read.',
      inputSchema: { notificationId: identifier },
    },
    ({ notificationId }) =>
      toolResult(async () => executeReadNotification(await session(), notificationId)),
  );

  server.registerTool(
    'mark_all_notifications_read',
    { description: 'Mark all of your notifications read.', inputSchema: {} },
    () => toolResult(async () => executeReadAllNotifications(await session())),
  );

  server.registerTool(
    'get_notification_preferences',
    {
      description:
        'Read your time zone, quiet hours, due-reminder time, reminder switches and muted containers.',
      inputSchema: {},
    },
    () =>
      toolResult(async () =>
        (await session()).client.query(notifications.preferences(), { forceRefresh: true }),
      ),
  );

  server.registerTool(
    'set_notification_preferences',
    {
      description:
        'Change only the given preferences. quiet is "HH:mm-HH:mm" or "off"; mute and unmute take container item ids.',
      inputSchema: {
        timeZone: z.string().max(64).optional(),
        quiet: z.string().max(11).optional(),
        dueReminderTime: z.string().max(5).optional(),
        dueReminders: z.boolean().optional(),
        habitReminders: z.boolean().optional(),
        mute: z.array(identifier).max(200).optional(),
        unmute: z.array(identifier).max(200).optional(),
      },
    },
    (input) =>
      toolResult(async () => {
        const onOff = (value: boolean | undefined) =>
          value === undefined ? undefined : value ? 'on' : 'off';
        const changes = parsePreferenceFlags({
          timeZone: input.timeZone,
          quiet: input.quiet,
          dueTime: input.dueReminderTime,
          dueReminders: onOff(input.dueReminders),
          habitReminders: onOff(input.habitReminders),
          mute: input.mute,
          unmute: input.unmute,
        });
        return executeSetPreferences(await session(), changes);
      }),
  );

  server.registerTool(
    'set_reminder',
    {
      description:
        'Remind yourself about an item once. when: local "2026-10-01T09:00", instant "...Z", zoned "...+01:00[Europe/London]" or relative "+90m"/"+2h"/"+1d". zone defaults to your preference.',
      inputSchema: {
        itemId: identifier,
        when: z.string().min(1).max(80),
        zone: z.string().max(64).optional(),
      },
    },
    ({ itemId, when, zone }) =>
      toolResult(async () => executeSetReminder(await session(), itemId, when, { zone })),
  );

  server.registerTool(
    'clear_reminder',
    { description: "Remove an item's reminder.", inputSchema: { itemId: identifier } },
    ({ itemId }) => toolResult(async () => executeClearReminder(await session(), itemId)),
  );

  server.registerTool(
    'set_item_protection',
    {
      description:
        'Protect an item from deletion, stop it accepting new children, or switch its live ' +
        "collaboration (off means one editor at a time). 'on' or 'off' for each; an omitted one is " +
        "left as it is. A linked calendar's own protection cannot be switched off here.",
      inputSchema: {
        itemId: identifier,
        delete: z.enum(['on', 'off']).optional(),
        children: z.enum(['on', 'off']).optional(),
        collaboration: z.enum(['on', 'off']).optional(),
      },
    },
    ({ itemId, delete: deletion, children, collaboration }) =>
      toolResult(async () =>
        executeProtect(await session(), itemId, {
          ...(deletion === undefined ? {} : { delete: deletion }),
          ...(children === undefined ? {} : { children }),
          ...(collaboration === undefined ? {} : { collaboration }),
        }),
      ),
  );
}
