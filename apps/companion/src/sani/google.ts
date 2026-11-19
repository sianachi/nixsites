import type { ConnectorAction } from './connector.ts';
import { gmailActions } from './google-gmail.ts';
import { googleCalendarActions } from './google-calendar.ts';
import { googleDriveActions } from './google-drive.ts';

export const googleActions: readonly ConnectorAction[] = [
  ...gmailActions,
  ...googleDriveActions,
  ...googleCalendarActions,
];
