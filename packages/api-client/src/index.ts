/**
 * The public surface of @nix/api-client.
 *
 * What is deliberately absent is the point of this file: no axios instance, no
 * axios types, no interceptor registry, no generic `request(method, url)`, no
 * options bag of magic strings. A consumer can create a client, describe
 * endpoints, execute them with cancellation, observe cache state and branch on
 * typed errors - and nothing else.
 *
 * Everything a caller receives has already been parsed against a Zod schema at
 * the boundary and deep-frozen. Nothing downstream re-validates.
 *
 * Later goals extend this surface by adding `src/generated/` (types generated
 * from Core's OpenAPI document) and `src/resources/` (typed per-resource
 * methods built from `defineQuery` / `defineCommand`), which are then exposed
 * here as `client.items`, `client.search` and so on. The transport, auth,
 * error, schema and cache layers below them do not change.
 */

export { createNixClient } from './client.js';
export type { CallOptions, NixClient } from './client.js';

export { defineCommand, defineQuery } from './endpoints.js';
export type {
  BinaryQueryEndpoint,
  CommandEndpoint,
  PagedQueryEndpoint,
  QueryEndpoint,
} from './endpoints.js';

export {
  NixApiError,
  NixErrorKind,
  httpStatusCode,
  isCanceledError,
  isNixApiError,
} from './errors.js';

export { createInMemoryTokenStore } from './auth.js';
export type { TokenProvider } from './auth.js';

export { cacheKeyToString } from './cache.js';
export type { CacheEntry, CacheKey } from './cache.js';

export {
  KNOWN_ITEM_TYPES,
  itemChartSchema,
  itemQueryResultsSchema,
  viewConfigurationSchema,
  itemSchema,
  propertyDefinitionSchema,
  emptyTemplateInitialization,
  templateApplicationRequestSchema,
  templateCaptureRequestSchema,
  templateDraftItemPatchSchema,
  templateDraftMetadataPatchSchema,
  templateInitializationRuleSchema,
  templateInitializationSchema,
  templateInputSchema,
  templateCatalogSchema,
  templateDetailSchema,
  templateImportPreviewSchema,
  templateSummarySchema,
  dailyNoteSettingsSchema,
} from './schemas/index.js';
export type {
  CursorPage,
  CalendarEntry,
  EffectiveSchema,
  ChartBucket,
  ItemChart,
  ItemQueryResults,
  QueryGroup,
  WorkspaceAggregate,
  PropertyDefinition,
  ViewConfiguration,
  QueryResultRow,
  SearchHit,
  SearchResults,
  Mention,
  Mentions,
  KeptItem,
  GraphLink,
  GraphNode,
  Item,
  ItemLock,
  ProblemDetails,
  CurrentPrincipal,
  Backlink,
  Backlinks,
  References,
  TemplateInitialization,
  TemplateInitializationRule,
  TemplateInput,
  TemplateReferenceRule,
  TemplateApplicationRequest,
  TemplateCaptureRequest,
  TemplateCaptureResult,
  TemplateDraft,
  TemplateCatalog,
  TemplateDetail,
  TemplateImport,
  TemplateImportPreview,
  TemplateImportProfile,
  TemplateImportResult,
  TemplateItem,
  TemplatePreflight,
  TemplateSummary,
  WorkspaceCalendar,
  WorkspaceGraph,
  RecurrenceFreq,
  RecurrenceWeekday,
  DailyNoteSettings,
  Workspace,
  WorkspaceInvitation,
  WorkspaceInvitee,
  WorkspaceMember,
  WorkspacePrincipal,
} from './schemas/index.js';

/**
 * Contract types, named one at a time, so a boundary schema living outside this package can tie
 * itself to the same source of truth with `satisfies`.
 *
 * The `components` map itself stays private, deliberately. Re-exporting it wholesale would make
 * every schema Core has - and every schema Core grows next - public API of this package the moment
 * `generate` runs, with nothing in between to notice. That contradicts the whole point of the file
 * you are reading. Adding a line here is the friction, and the friction is the feature: it is the
 * one place someone sees that a boundary schema has taken root outside the package that owns
 * boundaries, and can ask whether it should move in.
 *
 * Type-only. The generated file is rewritten wholesale by
 * `pnpm --filter @nix/api-client generate` and is not an editable surface.
 */
export type {
  AppendViewSetupRequestContract,
  ContainerViewsContract,
  CreateItemRequestContract,
  CreateStructuredItemRequestContract,
  SetViewsRequestContract,
  EffectiveSchemaContract,
  PropertyDefinitionContract,
  ViewContract,
  ViewRequestContract,
} from './contracts.js';

/**
 * Per-resource methods: the only place API paths appear. A caller builds a descriptor and hands it
 * to the client, so nothing above this package ever sees a URL.
 */
export * as accessTokens from './resources/access-tokens.js';
export * as health from './resources/health.js';
export * as principal from './resources/principal.js';
export * as pets from './resources/pets.js';
export { petSettingsSchema, petConnectionSchema, petProviderSchema } from './schemas/pets.js';
export type {
  PetProviderKey,
  PetProfile,
  PetSettings,
  PetSettingsResponse,
  PetConnection,
  PetMessage,
} from './schemas/pets.js';
export * as workspaceArrangement from './resources/workspace-arrangement.js';
export type {
  WorkspaceGroup,
  WorkspaceArrangementInput,
  WorkspaceArrangementResponse,
} from './schemas/workspace-arrangement.js';
export * as uiSettings from './resources/ui-settings.js';
export type { UiSettings, UiSettingsPatch } from './schemas/ui-settings.js';
export * as notifications from './resources/notifications.js';
export type {
  PreferencesInput,
  PrincipalPreferencesResponse,
  NotificationDto,
  NotificationsPageResponse,
} from './schemas/notifications.js';
export * as automations from './resources/automations.js';
export type {
  AutomationRuleInput,
  AutomationRuleResponse,
  AutomationRunResponse,
  AutomationRunsPageResponse,
  AutomationTestResponse,
} from './schemas/automations.js';
export * as calendarSync from './resources/calendar-sync.js';
export type {
  CalendarConnection,
  CalendarLink,
  CalendarSyncLogEntry,
  ExternalCalendar,
  WorkspaceCalendarLink,
} from './schemas/calendar-sync.js';
export * as bookmarks from './resources/bookmarks.js';
export * as locks from './resources/locks.js';
export * as items from './resources/items.js';
export * as workspaces from './resources/workspaces.js';
export type { AssignableWorkspaceRole } from './resources/workspaces.js';
export * as views from './resources/views.js';
export * as structure from './resources/structure.js';
export * as search from './resources/search.js';
export * as references from './resources/references.js';
export * as suggestions from './resources/suggestions.js';
export {
  MAXIMUM_MENTION_EXCLUSIONS,
  MAXIMUM_MENTION_TEXT_LENGTH,
  type MentionLookup,
} from './resources/suggestions.js';
export * as canvasLibrary from './resources/canvas-library.js';
export * as itemChart from './resources/item-chart.js';
export * as itemQuery from './resources/item-query.js';
export * as workspaceQuery from './resources/workspace-query.js';
export type { WorkspaceAggregateQuery, WorkspaceQueryMatch } from './resources/workspace-query.js';
export * as workspaceCalendar from './resources/workspace-calendar.js';
export * as workspaceGraph from './resources/workspace-graph.js';
export * as templates from './resources/templates.js';
export * as templateImports from './resources/template-imports.js';
export type { BeginTemplateImportInput } from './resources/template-imports.js';
export * as recurrence from './resources/recurrence.js';
export * as files from './resources/files.js';
export * as imports from './resources/imports.js';
export * as operations from './resources/operations.js';
export * as exports from './resources/exports.js';
export * as plugins from './resources/plugins.js';
export type { FileRecord, FileThumbnail, FileVersion } from './schemas/files.js';
export type { DocumentImport, DocumentImportPlan } from './schemas/imports.js';
export type { Operation } from './schemas/operations.js';
export type {
  Export,
  ExportDownloadCapability,
  ExportFormat,
  ExportFormatCatalog,
  ExportStatus,
} from './schemas/exports.js';
export {
  exportDownloadCapabilitySchema,
  exportFormatCatalogSchema,
  exportFormatSchema,
  exportStatusSchema,
} from './schemas/exports.js';
export * as companionBodies from './resources/companion-bodies.js';
export * as backups from './resources/backups.js';
export type { BackupRun, BackupStep } from './schemas/backups.js';
export * as sites from './resources/sites.js';
export * as tenantRoles from './resources/tenant-roles.js';
export type { UpdateSiteInput } from './resources/sites.js';
export type {
  Site,
  SiteBuild,
  SiteDatedCollection,
  SiteApproval,
  SiteApprovalEntry,
  SiteHostname,
  SiteLayout,
  SiteNavLink,
  SitePage,
  SiteRepublishMode,
  SiteServeMode,
} from './schemas/sites.js';
export type { PetToolCall } from './schemas/pets.js';

export * as comments from './resources/comments.js';
export type { AddCommentInput, ReplyCommentInput } from './resources/comments.js';
export type { Comment, CommentThread, CommentsResponse } from './schemas/comments.js';
export * as habits from './resources/habits.js';
export { type HabitTracker } from './schemas/habits.js';
export type { SetHabitInput } from './resources/habits.js';

export * as finance from './resources/finance.js';
export {
  type Finance,
  type FinanceAccountType,
  type FinanceAccount,
  type BudgetLine,
  type FinanceTransaction,
  type FinanceTransactions,
  type BudgetCell,
  type BudgetGrid,
  type BudgetActual,
  type FinanceAccounts,
  type LoanSchedule,
  type CashFlowMonth,
  type CashFlow,
  type Upcoming,
  type FinanceDashboard,
  type MonthChecklist,
  type PostScheduled,
  type FinanceImport,
} from './schemas/finance.js';
export type {
  FinanceSettingsInput,
  FinanceAccountInput,
  BudgetLineInput,
  FinanceTransactionInput,
  BudgetActualInput,
  FinanceImportInput,
} from './resources/finance.js';

export * as conversations from './resources/conversations.js';
export * from './schemas/conversations.js';
export {
  OPERATIONS,
  OperationCallError,
  callOperation,
  findOperations,
  isHumanOnlyOperation,
  operationById,
  operationRequest,
  operationRisk,
} from './operations.js';
export type { OperationCall, OperationEntry, OperationRisk } from './operations.js';
