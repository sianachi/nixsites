import type { components } from './generated/api.js';

/**
 * The contract types this package publishes, one alias per schema.
 *
 * These exist so a boundary schema that lives outside this package can still be tied to the
 * generated contract with `satisfies z.ZodType<...>`, the way `schemas/item.ts` ties `itemSchema`.
 * The `components` map stays private: exporting it would hand every consumer every schema Core has
 * or will grow, and a schema would become public API of this package the moment `generate` ran,
 * with no review step anywhere in between.
 *
 * So each alias is added by hand, when something outside actually needs it. That is the point of
 * friction where somebody notices that a boundary schema has grown outside the package that owns
 * boundaries - which is usually a sign it should move in, not a sign this list should get longer.
 */

/** One view over a container's children, as `GET /items/{id}/views` returns it. */
export type ViewContract = components['schemas']['ViewResponse'];

/** A container's views, its unrenderable ones, and which of them opens by default. */
export type ContainerViewsContract = components['schemas']['ContainerViewsResponse'];

/** The wire request to replace a container's whole view set: the views and which one opens. */
export type SetViewsRequestContract = components['schemas']['SetViewsRequest'];

/** An item's property schema: what it declares, what it inherits, and the resolved result. */
export type EffectiveSchemaContract = components['schemas']['EffectiveSchemaResponse'];

/** One property in a schema: its key, its label, its type and whether it is required. */
export type PropertyDefinitionContract = components['schemas']['PropertyDefinitionResponse'];

/** The signed-in caller, as `GET /api/v1/me` returns it. */
export type CurrentPrincipalContract = components['schemas']['CurrentPrincipalResponse'];

/** One template card in the workspace template catalog. */
export type TemplateSummaryContract = components['schemas']['TemplateSummaryResponse'];

/** The workspace template catalog and the caller's catalog-wide capabilities. */
export type TemplateCatalogContract = components['schemas']['TemplateCatalogResponse'];

/** One item in a captured template tree. */
export type TemplateItemContract = components['schemas']['TemplateItemResponse'];

/** A template catalog entry together with its captured root tree. */
export type TemplateDetailContract = components['schemas']['TemplateDetailResponse'];

/** The wire request used to validate a template application before mutation. */
export type TemplatePreflightRequestContract = components['schemas']['TemplatePreflightRequest'];

/** The additions and conflicts found while validating a template application. */
export type TemplatePreflightContract = components['schemas']['TemplatePreflightResponse'];

/** Item and view write shapes, kept generated so descriptor bodies cannot drift from OpenAPI. */
export type CreateItemRequestContract = components['schemas']['CreateItemRequest'];
export type CreateStructuredItemRequestContract =
  components['schemas']['CreateStructuredItemRequest'];
export type StructuredItemContract = components['schemas']['StructuredItemResponse'];
export type UpdateItemRequestContract = components['schemas']['UpdateItemRequest'];
export type MoveItemRequestContract = components['schemas']['MoveItemRequest'];
export type AppendViewSetupRequestContract = components['schemas']['AppendViewSetupRequest'];
export type ReplaceViewSetupRequestContract = components['schemas']['ReplaceViewSetupRequest'];
export type ViewRequestContract = components['schemas']['ViewRequest'];

export type SaveDailyNoteSettingsRequestContract =
  components['schemas']['SaveDailyNoteSettingsRequest'];
export type CreateWorkspaceRequestContract = components['schemas']['CreateWorkspaceRequest'];
export type RenameWorkspaceRequestContract = components['schemas']['RenameWorkspaceRequest'];
export type SetWorkspaceSharingRequestContract =
  components['schemas']['SetWorkspaceSharingRequest'];
export type ChangeWorkspaceMemberRoleRequestContract =
  components['schemas']['ChangeWorkspaceMemberRoleRequest'];
export type CreateWorkspaceInvitationRequestContract =
  components['schemas']['CreateWorkspaceInvitationRequest'];
export type RecoverWorkspaceRequestContract = components['schemas']['RecoverWorkspaceRequest'];
