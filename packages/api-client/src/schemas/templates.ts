/**
 * Workspace-template boundary schemas.
 *
 * Core stores captured schemas and views as JSON objects so older archives remain readable. The
 * client still validates the vocabulary it renders and fills the additive defaults introduced by
 * later view versions. That normalization happens here, at the API boundary, rather than in each
 * template screen.
 */

import { z } from 'zod';
import type {
  TemplateCatalogContract,
  TemplateDetailContract,
  TemplateItemContract,
  TemplatePreflightContract,
  TemplatePreflightRequestContract,
  TemplateSummaryContract,
} from '../contracts.js';

const nonnegativeInt32Schema = z
  .union([z.int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.int().nonnegative().max(2_147_483_647));

const templateOriginSchema = z.enum(['seed', 'user', 'managed']);

/** A value a template asks for when a person creates a fresh instance. */
export const templateInputSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/),
    label: z.string().trim().min(1).max(120),
    type: z.enum(['text', 'date', 'member', 'item']),
    required: z.boolean(),
    defaultValue: z.string().max(4_096).nullable().default(null),
  })
  .strict();

/** One explicit instruction for a source item's stored or derived property. */
export const templateInitializationRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      sourceId: z.uuid(),
      propertyKey: z.string().min(1).max(160),
      kind: z.literal('keep'),
    })
    .strict(),
  z
    .object({
      sourceId: z.uuid(),
      propertyKey: z.string().min(1).max(160),
      kind: z.literal('clear'),
    })
    .strict(),
  z
    .object({
      sourceId: z.uuid(),
      propertyKey: z.string().min(1).max(160),
      kind: z.literal('set'),
      value: z.unknown().refine((value) => value !== null && value !== undefined),
    })
    .strict(),
  z
    .object({
      sourceId: z.uuid(),
      propertyKey: z.string().min(1).max(160),
      kind: z.literal('input'),
      inputKey: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      sourceId: z.uuid(),
      propertyKey: z.string().min(1).max(160),
      kind: z.literal('relativeDate'),
      inputKey: z.string().min(1).max(64),
      offsetDays: z.int().min(-36_500).max(36_500),
      timeOfDay: z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
        .nullable()
        .default(null),
      timeZone: z.string().min(1).max(128).nullable().default(null),
    })
    .strict(),
]);

const templateReferenceRuleSchema = z.discriminatedUnion('policy', [
  z.object({ sourceItemId: z.uuid(), policy: z.literal('retain') }).strict(),
  z.object({ sourceItemId: z.uuid(), policy: z.literal('omit') }).strict(),
  z
    .object({
      sourceItemId: z.uuid(),
      policy: z.literal('replace'),
      inputKey: z.string().min(1).max(64),
    })
    .strict(),
]);

/** Versioned authoring metadata; Core validates all identifiers against the saved tree. */
export const templateInitializationSchema = z
  .object({
    version: z.literal(1),
    inputs: z.array(templateInputSchema).max(100),
    rules: z.array(templateInitializationRuleSchema).max(2_000),
    references: z.array(templateReferenceRuleSchema).max(2_000),
  })
  .strict()
  .superRefine((initialization, context) => {
    if (initialization.rules.length + initialization.references.length > 2_000) {
      context.addIssue({ code: 'custom', message: 'Template initialization has too many rules.' });
    }
    const inputByKey = new Map<string, TemplateInput>();
    for (const [index, input] of initialization.inputs.entries()) {
      if (inputByKey.has(input.key)) {
        context.addIssue({
          code: 'custom',
          path: ['inputs', index, 'key'],
          message: 'Input keys must be unique.',
        });
      }
      inputByKey.set(input.key, input);
    }
    const ruleKeys = new Set<string>();
    for (const [index, rule] of initialization.rules.entries()) {
      const key = `${rule.sourceId}:${rule.propertyKey}`;
      if (ruleKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index],
          message: 'Each property may have one initialization rule.',
        });
      }
      ruleKeys.add(key);
      if (rule.kind === 'input' || rule.kind === 'relativeDate') {
        const input = inputByKey.get(rule.inputKey);
        if (input === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['rules', index, 'inputKey'],
            message: 'The rule refers to a missing input.',
          });
        } else if (rule.kind === 'relativeDate' && input.type !== 'date') {
          context.addIssue({
            code: 'custom',
            path: ['rules', index, 'inputKey'],
            message: 'Relative date rules need a date input.',
          });
        }
        if (
          rule.kind === 'relativeDate' &&
          (rule.timeOfDay === null) !== (rule.timeZone === null)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['rules', index],
            message: 'Time and time zone must be supplied together.',
          });
        }
      }
    }
    const referenceSources = new Set<string>();
    for (const [index, rule] of initialization.references.entries()) {
      if (referenceSources.has(rule.sourceItemId)) {
        context.addIssue({
          code: 'custom',
          path: ['references', index],
          message: 'Each external reference may have one policy.',
        });
      }
      referenceSources.add(rule.sourceItemId);
      if (rule.policy === 'replace' && inputByKey.get(rule.inputKey)?.type !== 'item') {
        context.addIssue({
          code: 'custom',
          path: ['references', index, 'inputKey'],
          message: 'Reference replacement needs an item input.',
        });
      }
    }
  });

export type TemplateInput = z.infer<typeof templateInputSchema>;
export type TemplateInitializationRule = z.infer<typeof templateInitializationRuleSchema>;
export type TemplateReferenceRule = z.infer<typeof templateReferenceRuleSchema>;
export type TemplateInitialization = z.infer<typeof templateInitializationSchema>;

const templateInputValuesSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.string().max(4_096))
  .superRefine((values, context) => {
    if (Object.keys(values).length > 100) {
      context.addIssue({ code: 'custom', message: 'A template accepts at most 100 inputs.' });
    }
  });

export const templateCaptureRequestSchema = z.object({
  workspaceId: z.uuid(),
  sourceItemId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().nullable().optional(),
  includeBody: z.boolean(),
  includeChildren: z.boolean(),
  idempotencyKey: z.string().min(1).max(200),
  expectedFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export const templateCapturePreviewSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  captureFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceTitle: z.string(),
  itemCount: z.int().nonnegative(),
});

export const templateCaptureResultSchema = z.object({
  templateId: z.uuid(),
  operationId: z.uuid(),
  fileTransferJobId: z.uuid().nullable().optional(),
  fileTransferPending: z.boolean().optional(),
  writtenTargetItemIds: z.array(z.uuid()),
});

export const templateApplicationRequestSchema = z
  .object({
    templateId: z.uuid(),
    mode: z.enum(['merge', 'create']),
    targetItemId: z.uuid().nullable().optional(),
    parentItemId: z.uuid().nullable().optional(),
    title: z.string().max(200).optional(),
    inputs: templateInputValuesSchema.optional(),
    expectedRevision: nonnegativeInt32Schema.optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const templateApplicationResultSchema = z.object({
  applicationId: z.uuid(),
  templateId: z.uuid(),
  targetItemId: z.uuid(),
  alreadyApplied: z.boolean(),
  createdItems: z.array(z.object({ sourceId: z.uuid(), itemId: z.uuid(), itemType: z.string() })),
  resolvedInputs: templateInputValuesSchema,
  textBindings: z.record(z.string(), z.string()),
  referenceMappings: z.record(z.uuid(), z.uuid().nullable()),
  fileTransferJobId: z.uuid().nullable().optional(),
  fileTransferPending: z.boolean().optional(),
  writtenTargetItemIds: z.array(z.uuid()),
  operationId: z.uuid(),
});

export const templateDraftSchema = z.object({
  operationId: z.uuid(),
  templateId: z.uuid(),
  fileTransferJobId: z.uuid().nullable().optional(),
  fileTransferPending: z.boolean().optional(),
  title: z.string(),
  description: z.string().nullable(),
  initialization: templateInitializationSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  root: z.lazy(() => templateItemSchema),
  itemMappings: z.array(z.object({ sourceId: z.uuid(), itemId: z.uuid(), itemType: z.string() })),
  bodyCopies: z.array(
    z.object({ sourceItemId: z.uuid(), targetItemId: z.uuid(), itemType: z.string() }),
  ),
});

export const templateDraftMetadataPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4_096).nullable().optional(),
    initialization: templateInitializationSchema.optional(),
  })
  .strict();

export const templateDraftItemPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    properties: z.record(z.string(), z.unknown()).nullable().optional(),
    schema: z
      .object({ properties: z.array(z.unknown()), inherit: z.boolean() })
      .nullable()
      .optional(),
    views: z.unknown().nullable().optional(),
  })
  .strict();

export type TemplateCaptureRequest = z.infer<typeof templateCaptureRequestSchema>;
export type TemplateCapturePreview = z.infer<typeof templateCapturePreviewSchema>;
export type TemplateCaptureResult = z.infer<typeof templateCaptureResultSchema>;
export type TemplateApplicationRequest = z.infer<typeof templateApplicationRequestSchema>;
export type TemplateApplicationResult = z.infer<typeof templateApplicationResultSchema>;
export type TemplateDraft = z.infer<typeof templateDraftSchema>;

export const emptyTemplateInitialization: TemplateInitialization = {
  version: 1,
  inputs: [],
  rules: [],
  references: [],
};

const templateCapabilitiesSchema = z.object({
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canExport: z.boolean(),
  canApply: z.boolean(),
});

export const templateSummarySchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  origin: templateOriginSchema,
  revision: nonnegativeInt32Schema,
  includeBody: z.boolean(),
  includeChildren: z.boolean(),
  fieldCount: nonnegativeInt32Schema,
  viewCount: nonnegativeInt32Schema,
  childCount: nonnegativeInt32Schema,
  viewKinds: z.array(z.string()),
  capabilities: templateCapabilitiesSchema,
  updatedAt: z.iso.datetime({ offset: true }),
});

export type TemplateSummary = z.infer<typeof templateSummarySchema>;

const _templateSummaryContract = templateSummarySchema satisfies z.ZodType<TemplateSummaryContract>;
void _templateSummaryContract;

export const templateCatalogSchema = z.object({
  templates: z.array(templateSummarySchema),
  capabilities: z.object({ canManage: z.boolean() }),
});

export type TemplateCatalog = z.infer<typeof templateCatalogSchema>;

const _templateCatalogContract = templateCatalogSchema satisfies z.ZodType<TemplateCatalogContract>;
void _templateCatalogContract;

const templatePropertyDefinitionSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  options: z.array(z.string()).default([]),
  required: z.boolean(),
  expression: z.string().nullable().default(null),
  aggregate: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
  choiceSource: z
    .object({ itemId: z.uuid().nullable(), field: z.string().min(1).max(160) })
    .nullable()
    .default(null),
});

const storedTemplateSchemaSchema = z.object({
  properties: z.array(templatePropertyDefinitionSchema),
  declared: z.array(templatePropertyDefinitionSchema).optional(),
  inherit: z.boolean().default(true),
});

export const templateEffectiveSchemaSchema = z.object({
  properties: z.array(templatePropertyDefinitionSchema),
  declared: z.array(templatePropertyDefinitionSchema),
  inherit: z.boolean(),
});

const templateFormConditionSchema = z.object({
  fieldBlockId: z.string(),
  operator: z.string(),
  value: z.string().nullable(),
});

const templateFormBlockSchema = z.object({
  id: z.string(),
  kind: z.string(),
  propertyKey: z.string().nullable(),
  text: z.string(),
  help: z.string().nullable(),
  required: z.boolean(),
  identityRole: z.string().nullable(),
  visibleWhen: z.array(templateFormConditionSchema),
});

const templateFormPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  visibleWhen: z.array(templateFormConditionSchema),
  blocks: z.array(templateFormBlockSchema),
});

const templateInteractiveFormSchema = z.object({
  pages: z.array(templateFormPageSchema),
  titleMode: z.string(),
  titleFieldBlockId: z.string().nullable(),
  confirmationTitle: z.string(),
  confirmationMessage: z.string(),
});

const templateViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  columns: z.array(z.string()).default([]),
  groupBy: z.string().nullable().default(null),
  groupOrder: z.array(z.string()).default([]),
  dateProperty: z.string().nullable().default(null),
  sortBy: z.string().nullable().default(null),
  sortDescending: z.boolean().default(false),
  mode: z.string().nullable().default(null),
  coverProperty: z.string().nullable().default(null),
  endDateProperty: z.string().nullable().default(null),
  cardSize: z.string().nullable().default(null),
  layout: z.string().nullable().default(null),
  open: z.string().nullable().default(null),
  filters: z
    .array(
      z.object({
        property: z.string(),
        operator: z.string(),
        value: z.string(),
      }),
    )
    .default([]),
  companionViewId: z.string().nullable().default(null),
  companionPlacement: z.enum(['below', 'beside']).nullable().default(null),
  interactiveForm: templateInteractiveFormSchema.nullable().default(null),
});

const templateViewsSchema = z.object({
  views: z.array(templateViewSchema),
  default: z
    .string()
    .nullable()
    .default(null)
    .transform((value) => value ?? 'document'),
});

const storedTemplateItemFieldsSchema = z.object({
  sourceId: z.uuid(),
  itemType: z.string(),
  title: z.string(),
  seq: z.union([z.int(), z.string().regex(/^-?\d+$/)]).transform(String),
  properties: z.record(z.string(), z.unknown()).nullable().default(null),
  schema: storedTemplateSchemaSchema.nullable().default(null),
  views: templateViewsSchema.nullable().default(null),
  hasBody: z.boolean(),
  recurrence: z.record(z.string(), z.unknown()).nullable().default(null),
});

type StoredTemplateItemFields = z.infer<typeof storedTemplateItemFieldsSchema>;
type StoredTemplateItem = StoredTemplateItemFields & {
  children: StoredTemplateItem[];
};

const storedTemplateItemSchema: z.ZodType<StoredTemplateItem> =
  storedTemplateItemFieldsSchema.extend({
    children: z.lazy(() => z.array(storedTemplateItemSchema)),
  });

type TemplateEffectiveSchema = z.infer<typeof templateEffectiveSchemaSchema>;
type TemplateViews = z.infer<typeof templateViewsSchema>;

export type TemplateItem = Omit<StoredTemplateItemFields, 'schema' | 'views'> & {
  schema: TemplateEffectiveSchema | null;
  views: TemplateViews | null;
  children: TemplateItem[];
};

/**
 * `packages/structure-spec/src/vocabulary/merge-properties.ts` keeps its own copy of this same
 * merge rule (api-client cannot depend on sibling packages, and structure-spec cannot depend on
 * api-client's Zod-tied types). A change to the rule here must be made there too; nothing
 * automated compares the two, so this is a review-time obligation, not an enforced one.
 */
function mergeProperties(
  farther: readonly z.infer<typeof templatePropertyDefinitionSchema>[],
  nearer: readonly z.infer<typeof templatePropertyDefinitionSchema>[],
): readonly z.infer<typeof templatePropertyDefinitionSchema>[] {
  const replacements = new Map(nearer.map((property) => [property.key, property]));
  const inheritedKeys = new Set(farther.map((property) => property.key));
  return [
    ...farther.map((property) => replacements.get(property.key) ?? property),
    ...nearer.filter((property) => !inheritedKeys.has(property.key)),
  ];
}

function normalizeTemplateItem(
  item: StoredTemplateItem,
  inherited: readonly z.infer<typeof templatePropertyDefinitionSchema>[] = [],
): TemplateItem {
  const declared = item.schema?.declared ?? item.schema?.properties ?? [];
  const effective =
    item.schema?.declared !== undefined
      ? item.schema.properties
      : item.schema?.inherit === false
        ? declared
        : mergeProperties(inherited, declared);
  const schema =
    item.schema === null
      ? inherited.length === 0
        ? null
        : { properties: [...inherited], declared: [], inherit: true }
      : { properties: [...effective], declared, inherit: item.schema.inherit };

  return {
    ...item,
    schema,
    children: item.children.map((child) => normalizeTemplateItem(child, schema?.properties ?? [])),
  };
}

export const templateItemSchema: z.ZodType<TemplateItem> = storedTemplateItemSchema.transform(
  (item) => normalizeTemplateItem(item),
);

const _templateItemContract = templateItemSchema satisfies z.ZodType<TemplateItemContract>;
void _templateItemContract;

export const templateDetailSchema = templateSummarySchema.extend({
  root: templateItemSchema,
  initialization: templateInitializationSchema.default({
    version: 1,
    inputs: [],
    rules: [],
    references: [],
  }),
});
export type TemplateDetail = z.infer<typeof templateDetailSchema>;

const _templateDetailContract = templateDetailSchema satisfies z.ZodType<TemplateDetailContract>;
void _templateDetailContract;

/** The form accepts omitted nullable values; the wire schema normalizes them to explicit nulls. */
const templatePreflightInputSchema = z.object({
  mode: z.enum(['merge', 'create']),
  targetItemId: z.uuid().nullable().optional(),
  parentItemId: z.uuid().nullable().optional(),
  title: z.string().nullable().optional(),
  inputs: templateInputValuesSchema.optional(),
  expectedRevision: nonnegativeInt32Schema.optional(),
});

export type TemplatePreflightInput = z.infer<typeof templatePreflightInputSchema>;

export const templatePreflightRequestSchema = templatePreflightInputSchema.transform((input) => ({
  mode: input.mode,
  targetItemId: input.targetItemId ?? null,
  parentItemId: input.parentItemId ?? null,
  title: input.title ?? null,
  ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
  ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
}));

const _templatePreflightRequestContract =
  templatePreflightRequestSchema satisfies z.ZodType<TemplatePreflightRequestContract>;
void _templatePreflightRequestContract;

export const templatePreflightSchema = z.object({
  templateId: z.uuid(),
  templateRevision: nonnegativeInt32Schema,
  mode: z.enum(['merge', 'create']),
  additions: z.object({
    fields: nonnegativeInt32Schema,
    views: nonnegativeInt32Schema,
    items: nonnegativeInt32Schema,
  }),
  conflicts: z.array(z.string()),
  canApply: z.boolean(),
  expectedRevision: nonnegativeInt32Schema.optional(),
  initializationPreview: z
    .array(
      z.object({
        sourceId: z.uuid(),
        title: z.string(),
        properties: z.record(z.string(), z.unknown()).nullable(),
        recurrence: z.record(z.string(), z.unknown()).nullable(),
      }),
    )
    .default([]),
  resolvedInputs: templateInputValuesSchema.default({}),
  textBindings: z.record(z.string(), z.string()).default({}),
  referenceMappings: z.record(z.string(), z.string().nullable()).default({}),
});

export type TemplatePreflight = z.infer<typeof templatePreflightSchema>;

const _templatePreflightContract =
  templatePreflightSchema satisfies z.ZodType<TemplatePreflightContract>;
void _templatePreflightContract;
