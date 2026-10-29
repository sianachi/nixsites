/** Compatibility entry point for the web test Core stub. */
export { stubCoreApi } from './api-stub/core';
export { STUB_TEMPLATE_IMPORT_ID } from './api-stub/core';
export { item } from './api-stub/resources/items';
export { STUB_WORKSPACE_ID } from './api-stub/resources/items';
export { STUB_WORKSPACE } from './api-stub/resources/workspaces';
export { STUB_TEMPLATES } from './api-stub/resources/templates';
export { STUB_DEFAULT_PREFERENCES } from './api-stub/core';

export type { StubAccessToken, StubMember } from './api-stub/resources/identity';
export type { StubInvitation, StubInvitee, StubWorkspace } from './api-stub/resources/workspaces';
export type { StubItem } from './api-stub/resources/items';
export type { StubTemplate } from './api-stub/resources/templates';
export type {
  StubOptions,
  StubSchemas,
  StubViews,
  StubWrites,
  StubPreferences,
  StubNotification,
  StubPushSubscription,
} from './api-stub/core';
