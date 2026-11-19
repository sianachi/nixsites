import type { ConnectorAction } from './connector.ts';
import { githubActions } from './github.ts';
import { linearActions } from './linear-actions.ts';
import { slackActions } from './slack.ts';

export const opsActions: readonly ConnectorAction[] = [
  ...githubActions,
  ...linearActions,
  ...slackActions,
];
