/**
 * Zod schemas for every API boundary shape.
 *
 * Generated OpenAPI types live next to this directory in `src/generated/`, refreshed with
 * `pnpm --filter @nix/api-client generate` whenever Core announces a contract change. Every
 * schema here asserts structural agreement with them via `satisfies`, so a backend rename is a
 * build failure in this package rather than a runtime surprise in a component.
 *
 * Nothing in this directory imports transport code, so schemas stay usable from tests, mocks and
 * MSW handlers.
 */

import { z } from 'zod';

export { problemDetailsSchema, type ProblemDetails } from './problem-details.js';
export { cursorPageSchema, type CursorPage } from './pagination.js';
export { itemSchema, KNOWN_ITEM_TYPES, type Item } from './item.js';
export { canvasLibrarySchema, type CanvasLibrary } from './canvas-library.js';
export {
  workspaceGraphSchema,
  type GraphLink,
  type GraphNode,
  type WorkspaceGraph,
} from './workspace-graph.js';
export {
  workspaceCalendarSchema,
  type CalendarEntry,
  type WorkspaceCalendar,
} from './workspace-calendar.js';
export { shelfSchema, type KeptItem, type Shelf } from './bookmarks.js';
export {
  itemLockSchema,
  unlockItemResultSchema,
  type ItemLock,
  type UnlockItemResult,
} from './locks.js';
export { currentPrincipalSchema, type CurrentPrincipal } from './current-principal.js';
export {
  backlinksSchema,
  referencesSchema,
  type Backlink,
  type Backlinks,
  type References,
} from './references.js';
export {
  dailyNoteSchema,
  dailyNoteSettingsSchema,
  workspaceInvitationSchema,
  workspaceInviteeSchema,
  workspaceMemberSchema,
  workspacePrincipalSchema,
  workspaceSchema,
  type DailyNote,
  type DailyNoteSettings,
  type Workspace,
  type WorkspaceInvitation,
  type WorkspaceInvitee,
  type WorkspaceMember,
  type WorkspacePrincipal,
} from './workspaces.js';
export {
  containerViewConfigurationsSchema,
  containerViewsSchema,
  viewConfigurationSchema,
  type ContainerViewConfigurations,
  type ContainerViews,
  type ViewConfiguration,
} from './views.js';
export {
  effectiveSchemaSchema,
  propertyDefinitionSchema,
  type EffectiveSchema,
  type PropertyDefinition,
} from './structure.js';
export { searchResultsSchema, type SearchHit, type SearchResults } from './search.js';
export {
  mentionsSchema,
  relatedItemsSchema,
  type Mention,
  type Mentions,
  type RelatedItems,
} from './suggestions.js';
export {
  ACCESS_TOKEN_SCOPES,
  accessTokenListSchema,
  accessTokenSchema,
  createdAccessTokenSchema,
  tokenExchangeResponseSchema,
  type AccessTokenList,
  type CreatedAccessToken,
  type TokenExchangeResponse,
} from './access-tokens.js';
export { itemChartSchema, type ChartBucket, type ItemChart } from './item-chart.js';
export {
  itemQueryResultsSchema,
  type ItemQueryResults,
  type QueryResultRow,
} from './item-query.js';
export {
  workspaceAggregateSchema,
  workspaceQueryResultsSchema,
  type QueryGroup,
  type WorkspaceAggregate,
  type WorkspaceQueryResults,
} from './workspace-query.js';
export {
  emptyTemplateInitialization,
  templateApplicationRequestSchema,
  templateApplicationResultSchema,
  templateCaptureRequestSchema,
  templateCaptureResultSchema,
  templateCapturePreviewSchema,
  templateDraftItemPatchSchema,
  templateDraftMetadataPatchSchema,
  templateDraftSchema,
  templateInitializationRuleSchema,
  templateInitializationSchema,
  templateInputSchema,
  templateCatalogSchema,
  templateDetailSchema,
  templateItemSchema,
  templatePreflightRequestSchema,
  templatePreflightSchema,
  templateSummarySchema,
  type TemplateInitialization,
  type TemplateInitializationRule,
  type TemplateInput,
  type TemplateReferenceRule,
  type TemplateApplicationRequest,
  type TemplateApplicationResult,
  type TemplateCaptureRequest,
  type TemplateCapturePreview,
  type TemplateCaptureResult,
  type TemplateDraft,
  type TemplateCatalog,
  type TemplateDetail,
  type TemplateItem,
  type TemplatePreflight,
  type TemplatePreflightInput,
  type TemplateSummary,
} from './templates.js';
export {
  templateImportPreviewSchema,
  type TemplateImport,
  type TemplateImportPreview,
  type TemplateImportProfile,
  type TemplateImportResult,
} from './template-imports.js';
export {
  completeOccurrenceResultSchema,
  setRecurrenceResultSchema,
  type CompleteOccurrenceResult,
  type RecurrenceFreq,
  type RecurrenceWeekday,
  type SetRecurrenceResult,
} from './recurrence.js';

/**
 * Response schema for endpoints that answer 204 No Content. The transport
 * normalises an empty body to `undefined` before parsing, so this is the
 * honest type for "succeeded, returned nothing".
 */
export const noContentSchema = z.undefined();
