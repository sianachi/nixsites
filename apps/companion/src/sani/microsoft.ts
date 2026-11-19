import type { ConnectorAction } from './connector.ts';
import { outlookCalendarActions } from './microsoft.calendar.ts';
import { oneDriveActions } from './microsoft.drive.ts';
import { outlookMailActions } from './microsoft.mail.ts';
import { teamsActions } from './microsoft.teams.ts';

export const microsoftActions: readonly ConnectorAction[] = [
  ...outlookMailActions,
  ...oneDriveActions,
  ...teamsActions,
  ...outlookCalendarActions,
];
