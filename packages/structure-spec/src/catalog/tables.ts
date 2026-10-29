/**
 * The pure data tables behind the pet's capability catalog: everything a model needs to know
 * about what it may build, in one place, so the catalog text (`build.ts`), the Zod limits a
 * later task adds under `spec/*`, and the parity tests a later task adds for Go, C# and web all
 * read from the same source instead of restating it three times.
 *
 * These are facts about what Core and the compiler accept, not facts about the vocabulary
 * already carried by `property-types.ts`, `recipes.ts` or `smart-lists.ts` - `build.ts` composes
 * both kinds into one catalog.
 */

/** How a view kind's one required field, if it has one, must be satisfied. */
export type ViewKindRequirement =
  | { readonly field: 'groupBy'; readonly shape: 'select' }
  | { readonly field: 'columnBy'; readonly shape: 'select or checkbox' }
  | { readonly field: 'groupBy'; readonly shape: 'select-or-date' }
  | { readonly field: 'date'; readonly shape: 'date-shaped' }
  | null;

/** One optional field a view kind accepts beyond its requirement, and what it needs to be. */
export interface ViewKindOptionalField {
  readonly field: string;
  readonly shape: string;
}

export interface ViewKindRule {
  readonly kind: string;
  readonly label: string;
  readonly requires: ViewKindRequirement;
  readonly optional: readonly ViewKindOptionalField[];
  readonly description: string;
}

/**
 * Every view kind a spec or a blueprint may declare, and what it needs from the schema.
 *
 * `drive` and `finance` are Core view kinds (`ViewKinds.All` in `ViewDefinition.cs`) the pet may
 * never offer - a public file drive and personal finances are not something a model should be
 * designing on somebody's behalf - so they have no row here. A future parity test comparing this
 * table against `ViewKinds.All` needs to add both back in before comparing.
 */
export const VIEW_KIND_RULES = [
  {
    kind: 'chat',
    label: 'Chat',
    requires: null,
    optional: [],
    description: 'Message children using the chat message schema.',
  },
  {
    kind: 'list',
    label: 'List',
    requires: null,
    optional: [{ field: 'groupBy', shape: 'select, checkbox or $type' }],
    description: 'Rows and columns, one row per child, optionally in sections.',
  },
  {
    kind: 'board',
    label: 'Board',
    requires: { field: 'groupBy', shape: 'select' },
    optional: [],
    description: 'Cards grouped into columns by a single select property.',
  },
  {
    kind: 'calendar',
    label: 'Calendar',
    requires: { field: 'date', shape: 'date-shaped' },
    optional: [],
    description: 'Items placed on a day, week or month by a date property.',
  },
  {
    kind: 'timeline',
    label: 'Timeline',
    requires: { field: 'date', shape: 'date-shaped' },
    optional: [{ field: 'endDate', shape: 'date-shaped' }],
    description: 'Bars across a time axis; without an end date an item is a milestone.',
  },
  {
    kind: 'gallery',
    label: 'Gallery',
    requires: null,
    optional: [
      { field: 'cover', shape: 'image' },
      { field: 'columns', shape: 'field keys' },
    ],
    description: 'Cards with an optional picture and chosen fields.',
  },
  {
    kind: 'sheet',
    label: 'Spreadsheet',
    requires: null,
    optional: [],
    description: 'Children as an editable grid, one row per child and one column per property.',
  },
  {
    kind: 'form',
    label: 'Form',
    requires: null,
    optional: [{ field: 'mode', shape: 'saved or temporary' }],
    description: 'A single-page form; answers stay temporary or create a child.',
  },
  {
    kind: 'interactive_form',
    label: 'Interactive form',
    requires: null,
    optional: [{ field: 'mode', shape: 'saved or temporary' }],
    description: 'A multi-page, conditional form; answers stay temporary or create a child.',
  },
  {
    kind: 'query',
    label: 'Smart list',
    requires: null,
    optional: [],
    description: 'Saved query rows show filter fields; columns are not configurable.',
  },
  {
    kind: 'chart',
    label: 'Chart',
    requires: { field: 'groupBy', shape: 'select-or-date' },
    optional: [
      { field: 'measureField', shape: 'number' },
      { field: 'splitBy', shape: 'select-or-checkbox' },
    ],
    description:
      'Children counted or totalled per select value, or per period of a date (set period). chartKind: bar, column, pie, or line/area/year on a date; splitBy makes series.',
  },
  {
    kind: 'habit_tracker',
    label: 'Habit tracker',
    requires: null,
    optional: [],
    description: 'Child habit settings and dated check-ins, not column mappings.',
  },
  {
    kind: 'checklist',
    label: 'Checklist',
    requires: null,
    optional: [{ field: 'doneProperty', shape: 'checkbox' }],
    description:
      'A box to tick per child, with progress; first property column appears beside title.',
  },
  {
    kind: 'matrix',
    label: 'Matrix',
    requires: { field: 'columnBy', shape: 'select or checkbox' },
    optional: [{ field: 'rowBy', shape: 'select or checkbox, required' }],
    description: 'Cards in a grid of cells, placed by two properties at once.',
  },
  {
    kind: 'outline',
    label: 'Outline',
    requires: null,
    optional: [],
    description: 'The subtree as a collapsible tree of titles, reshaped by keyboard.',
  },
  {
    kind: 'custom',
    label: 'Custom',
    requires: null,
    optional: [{ field: 'program', shape: 'openui-lang, required' }],
    description: 'A program drawn over the children; see Custom views. Only when no kind fits.',
  },
] as const satisfies readonly ViewKindRule[];

/** The recipe ids the pet may never use: a file drive and personal finances are studio-only. */
export const NEVER_PET_RECIPES: ReadonlySet<string> = new Set(['drive', 'finances']);

/** The one property type the pet may never declare: values are member UUIDs it cannot verify. */
export const NEVER_PET_PROPERTY_TYPE = 'assignee';

export interface QueryOperatorRule {
  readonly op: string;
  readonly grammar: string;
}

/** The day tokens a day operator accepts, spelled once for the grammar sentences below. */
const DAY_GRAMMAR =
  '"today", "start-of-week", "start-of-month", "same-day-last-week", "same-day-last-month" or a yyyy-MM-dd date';

/** The operators a query view's filters may use, and the value each one reads. */
export const QUERY_OPERATORS = [
  { op: 'equals', grammar: 'a literal value, or "me" for the calling principal' },
  { op: 'not-equals', grammar: 'a literal value, or "me" for the calling principal' },
  { op: 'on', grammar: DAY_GRAMMAR },
  { op: 'before', grammar: 'a day, as for on' },
  { op: 'on-or-after', grammar: 'a day, as for on' },
  { op: 'within-next', grammar: 'a whole number of days' },
  { op: 'within-last', grammar: 'a whole number of days' },
  { op: 'contains', grammar: 'text to find, ignoring case; or one multi-select option exactly' },
  {
    op: 'not-contains',
    grammar: 'text to find, ignoring case; or one multi-select option exactly',
  },
  { op: 'greater-than', grammar: 'a number' },
  { op: 'less-than', grammar: 'a number' },
  { op: 'is-empty', grammar: 'no value (empty string)' },
  { op: 'is-not-empty', grammar: 'no value (empty string)' },
] as const satisfies readonly QueryOperatorRule[];

export interface FormRules {
  readonly blockKinds: readonly string[];
  readonly conditionOperators: readonly string[];
  readonly identityRoles: readonly string[];
  readonly titleModes: readonly string[];
}

/** What an interactive form's pages, blocks and conditions may be built from. */
export const FORM_RULES = {
  blockKinds: ['field', 'heading', 'paragraph'],
  conditionOperators: ['equals', 'not_equals', 'contains', 'checked', 'not_checked'],
  identityRoles: ['name', 'email'],
  titleModes: ['generated', 'field'],
} as const satisfies FormRules;

export interface CatalogLimits {
  readonly rawToolCallBytes: number;
  readonly specJsonChars: number;
  readonly specJsonDepth: number;
  readonly blueprintNodes: number;
  readonly blueprintNonSampleNodes: number;
  readonly blueprintDepth: number;
  readonly fieldsPerNode: number;
  readonly fieldsPerBlueprint: number;
  readonly viewsPerNode: number;
  readonly viewsPerAddView: number;
  readonly viewsPerContainer: number;
  readonly viewsPerBlueprint: number;
  readonly sampleEntries: number;
  readonly plannedWritesPerBuild: number;
  readonly entriesPerCreateEntries: number;
  readonly inputsPerBlueprint: number;
  readonly initRulesPerBlueprint: number;
  readonly formulaLength: number;
  readonly toolResultChars: number;
}

/**
 * The size limits the pet's tools and blueprints are held to, as constants a later task's Zod
 * schemas import rather than repeating as literals - the source `renderCatalog`'s blueprint
 * summary and any future validator both read.
 */
export const LIMITS = {
  rawToolCallBytes: 40_000,
  specJsonChars: 24_000,
  specJsonDepth: 24,
  blueprintNodes: 40,
  blueprintNonSampleNodes: 15,
  blueprintDepth: 4,
  fieldsPerNode: 30,
  fieldsPerBlueprint: 80,
  viewsPerNode: 6,
  viewsPerAddView: 4,
  viewsPerContainer: 12,
  viewsPerBlueprint: 20,
  sampleEntries: 30,
  plannedWritesPerBuild: 80,
  entriesPerCreateEntries: 25,
  inputsPerBlueprint: 10,
  initRulesPerBlueprint: 100,
  formulaLength: 1024,
  toolResultChars: 16_000,
} as const satisfies CatalogLimits;

/** The two kinds of value a template input may collect. */
export const TEMPLATE_INPUT_TYPES = ['text', 'date'] as const satisfies readonly string[];

/** The five ways a blueprint's init rules may set a field when a template is applied. */
export const INIT_RULE_KINDS = [
  'keep',
  'clear',
  'set',
  'input',
  'relativeDate',
] as const satisfies readonly string[];

export interface RecurrenceRules {
  readonly frequencies: readonly string[];
  readonly intervalMin: number;
  readonly intervalMax: number;
}

/** What `RecurrenceSpec` accepts. */
export const RECURRENCE = {
  frequencies: ['daily', 'weekly', 'monthly', 'yearly'],
  intervalMin: 1,
  intervalMax: 366,
} as const satisfies RecurrenceRules;

export interface HabitRules {
  readonly frequencies: readonly string[];
}

/** What a blueprint node's `habit` settings accept. */
export const HABIT = {
  frequencies: ['daily', 'weekly'],
} as const satisfies HabitRules;

/**
 * The four things no pet operation may ever do, regardless of mode - enforced by construction
 * (no operation the pet can call publishes a link, deletes permanently, removes a
 * field, or deletes a view), and repeated here only so the model is told, not asked to infer it.
 */
export const NEVER_OPERATIONS = [
  'Publish a public link',
  'Delete anything permanently',
  'Remove a field',
  'Delete a view',
] as const satisfies readonly string[];

/**
 * The typed tool operations that build or extend an item's structure - as opposed to the plain
 * item operations (`create_note`, `set_properties`, ...) and the template operations
 * (`list_templates`, `read_template`, `apply_template`) - named once so the catalog text
 * (`build.ts`) states them instead of a hand-typed sentence.
 *
 * This package is the source of truth for the list; the Go worker does not read it. Its
 * `catalog_test.go` keeps its own hand-typed `structureOperations` fixture and checks that each
 * name is still a `workspaceTools()` tool and still mentioned in the embedded catalog text, so
 * that fixture drifting out of step with this list fails a test instead of going unnoticed - but
 * a structure operation added here and forgotten there is not caught either way.
 */
export const STRUCTURE_OPERATIONS = [
  'create_structured',
  'add_view',
  'create_entries',
  'add_fields',
  'edit_fields',
  'edit_form',
  'update_view',
  'set_recurrence',
  'build_blueprint',
] as const satisfies readonly string[];

/**
 * Every operation a pet tool may name, in the order `@nix/companion`'s `workspaceToolSchema`
 * declares its flat `operation` enum. This package is the source of truth for that order:
 * `buildPetTools` (`tools.ts`) derives one typed function tool per operation from it,
 * `@nix/companion/tool-args.ts` imports it to build `workspaceToolSchema`, and the Go worker's
 * generated `tools-chat.json` (`scripts/build-catalog.ts`) is the same tools serialized for the
 * provider. Every conversation offers every operation.
 */
export const WORKSPACE_OPERATIONS = [
  'list_items',
  'search',
  'read_item',
  'read_note',
  'search_note',
  'read_structure',
  'read_view',
  'create_note',
  'append_note',
  'replace_section',
  'replace_passage',
  'rename_item',
  'move_item',
  'set_properties',
  'trash_item',
  'restore_item',
  'create_structured',
  'add_view',
  'create_entries',
  'add_fields',
  'edit_fields',
  'edit_form',
  'update_view',
  'set_recurrence',
  'list_templates',
  'read_template',
  'apply_template',
  'build_blueprint',
  'save_as_template',
  'read_calendar',
  'complete_task',
  'remember',
] as const satisfies readonly string[];

export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];

/** Operations the executor never writes through (`@nix/companion`'s `READ_ONLY_OPERATIONS`). */
export const READ_ONLY_OPERATION_NAMES = [
  'list_items',
  'search',
  'read_item',
  'read_note',
  'search_note',
  'read_structure',
  'read_view',
  'list_templates',
  'read_template',
  'read_calendar',
  // Writes nothing in the workspace: only the owner's private memory, shown in Settings.
  'remember',
] as const satisfies readonly WorkspaceOperation[];
