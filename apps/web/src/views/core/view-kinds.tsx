import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { PropertyDefinition, View } from './container-model';
import type { ContainerData } from './use-container';

/**
 * The registry of every kind of view this build can draw, and everything it knows about each one.
 *
 * The kinds register themselves at start-up (`views/builtin-views.tsx`, and the app's own
 * bootstrap for the kinds that live outside `views/`), so this file knows the shape of a kind and
 * none of them by name: `views/core` imports no view kind, and a kind can live in its own package.
 * The table each kind contributes, and why it is one table, is described where the built-in kinds
 * are declared.
 */

/**
 * What every renderer is handed.
 *
 * The three renderers were structurally similar and had no shared type, so nothing checked that a
 * fourth would fit. `view` is non-nullable here: the unconfigured case is not a kind and is handled
 * once, by the caller, rather than by every renderer accepting a null it mostly ignores.
 */
export interface ViewRendererProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

/** What a kind's own configuration block is handed, beside the shared controls. */
export interface ViewConfigurationEditorProps {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (view: View) => void;
}

/**
 * One property a kind can be configured from, and which properties will serve.
 *
 * A list needs none - with no columns configured it falls back to the effective schema, and with no
 * schema at all it still has titles to show - which is why a kind's list of these may be empty
 * rather than every kind carrying a vacuous one.
 */
export interface ViewConfiguration {
  /** The field on the view that names the property. */
  readonly field:
    | 'groupBy'
    | 'dateProperty'
    | 'coverProperty'
    | 'endDateProperty'
    | 'measureProperty'
    | 'doneProperty'
    | 'rowBy';

  readonly label: string;

  /** Said when the schema offers nothing this kind can use. */
  readonly emptyHint: string;

  /** Said when it does. */
  readonly hint: string;

  /**
   * What the "nothing chosen" option is called.
   *
   * **The copy itself, not a flag that picks between two spellings of it.** This began as
   * `optional?: boolean`, which was three states - true, false, absent - standing in for a
   * two-state decision, forced the editor to test `=== true`, and made a test assert the *absence
   * of a key* rather than a piece of wording. Holding the label removes the branch, removes the
   * defensiveness, and puts this kind's copy in the registry beside the rest of its copy.
   *
   * The distinction it carries: "Choose a property" for something the view is waiting on, "None"
   * for something the view is complete without. A gallery offered "Choose a property" would read as
   * unfinished, and somebody would go looking for what was broken.
   *
   * It says nothing about validation. The server decides what is storable and each renderer decides
   * what it can draw; a third opinion here could only disagree with one of them.
   */
  readonly emptyChoice: string;

  /** Which declared properties may be chosen. */
  readonly accepts: (property: PropertyDefinition) => boolean;

  /**
   * Fields that stop meaning anything when the chosen property changes.
   *
   * A board's column order belonged to the old property; carried across, it would filter the new
   * one down to values it does not have.
   */
  readonly clears?: Partial<View>;

  /**
   * Choices offered after the properties that are not properties themselves - a list's sections by
   * body kind, stored under the reserved `$type` key. Empty or absent for every kind whose
   * configuration is only ever a property.
   */
  readonly extraChoices?: readonly { readonly value: string; readonly label: string }[];

  /**
   * Brings the rest of the view back in line once the property is chosen, for a kind whose other
   * settings depend on what kind of property it is - a chart grouped by a date needs a period, and
   * one grouped by a select must not keep one. Applied after `clears`.
   */
  readonly normalize?: (view: View, fields: readonly PropertyDefinition[]) => View;
}

/**
 * One closed-set choice a kind offers, and the tokens it may take.
 *
 * The sibling of {@link ViewConfiguration} for the fields that are not properties: a card size is
 * not a key into the schema, so a property `<Select>` filtered by `accepts` has nothing to offer
 * it. The set is closed and small - which is `<Segmented>`'s territory - and the server refuses a
 * token outside it, so the options here are the contract's words and not a suggestion.
 *
 * The tokens are plain strings here; the kind that declares a choice ties them to its renderer's
 * own tuple (see `ChoiceTokens` in `views/builtin-views.tsx`).
 */
export type ChoiceField = 'cardSize' | 'measure' | 'layout';

export interface ViewChoiceOf<TField extends ChoiceField, TToken extends string> {
  /** The field on the view that stores the chosen token. */
  readonly field: TField;

  readonly label: string;

  /** Guidance under the control, said in terms of what changes on screen. */
  readonly hint: string;

  /** The tokens, in the order offered, each with the word a person sees. */
  readonly options: readonly { readonly value: TToken; readonly label: string }[];

  /**
   * The token a null field draws as, shown as current until somebody chooses.
   *
   * Null and this token render identically, so the control marking it current is the truth rather
   * than a claim about what is stored: choosing it explicitly changes nothing anybody can see.
   */
  readonly fallback: TToken;
}

type ViewChoice = {
  [TField in ChoiceField]: ViewChoiceOf<TField, string>;
}[ChoiceField];

export interface ViewKindDescriptor {
  /** The name this kind is stored and published under. */
  readonly kind: string;

  /** What a person sees in the switcher and the editor. */
  readonly label: string;

  readonly icon: LucideIcon;

  readonly render: (props: ViewRendererProps) => ReactNode;

  /**
   * Draws a container that has no views configured at all. Only the list supplies it: it needs no
   * configuration and has titles to show even with no schema.
   */
  readonly renderUnconfigured?: (props: Omit<ViewRendererProps, 'view'>) => ReactNode;

  /**
   * Every property this kind can be configured from, in the order the editor should offer them.
   *
   * **An array from the start, not a single slot that grows one later.** This was `ViewConfiguration
   * | null`, which was true of the three kinds that existed and was a shape rather than a rule: the
   * table's whole stated purpose is that adding a kind is one entry, and a shape that forces a type
   * change on the next kind fails that purpose whether or not the kind that trips it has landed yet.
   *
   * **What this actually buys, stated honestly, because the overclaim is tempting.** It makes the
   * editor's configuration block per-*property* rather than per-*kind*, so a kind needing two
   * properties - the timeline, with a start and an end - costs no change here and no second copy of
   * that block. It does *not* make a kind that needs a brand-new field cheap, and the timeline is
   * the receipt: `endDateProperty` had to be threaded through the `field` union below, the Zod
   * schema, the view record and its two contracts, the stored-JSON reader and writer, the OpenAPI
   * document, the generated client and every fixture. That threading is the cost of the flat view
   * record, which `ViewDefinition.cs` justifies on its own terms; changing it is an ADR, not a
   * refactor.
   *
   * Empty for a list, which needs nothing configured to draw.
   */
  readonly configures: readonly ViewConfiguration[];

  /**
   * The closed-set choices this kind offers, in the order the editor should offer them.
   *
   * Empty for every kind whose look is not adjustable, which keeps "adding a kind is one entry"
   * true for this axis the same way `configures` keeps it true for properties.
   */
  readonly chooses: readonly ViewChoice[];

  /**
   * The kind's own configuration block, drawn by the shared configuration after the "Open items"
   * choice: a chart's options, a checklist's detail property, an interactive form's steps.
   */
  readonly configurationEditor?: (props: ViewConfigurationEditorProps) => ReactNode;

  /**
   * Whether the editor offers this kind the filter-rules block.
   *
   * A capability flag rather than a `kind === 'query'` check in the editor, so "adding a kind is
   * one entry" survives the first kind whose configuration is neither a property slot nor a
   * closed token. The block itself lives with the query feature; the registry only says who gets
   * it.
   */
  readonly editsFilters?: true;

  /**
   * Whether this kind applies the filters saved on it to its own children (ADR-0054), and so
   * whether the editor offers them. A kind whose renderer ignores them - a chart's bars are counted
   * on the server without them - must not offer rules that would change nothing on screen.
   */
  readonly appliesSavedFilters?: true;
}

const registered: ViewKindDescriptor[] = [];

/** Every registered kind, in registration order: the order the view picker offers them. */
export const VIEW_KINDS: readonly ViewKindDescriptor[] = registered;

/**
 * Adds kinds after those already registered. A kind registered twice is a second bootstrap: it
 * throws in development, and in production the first registration stands.
 */
export function registerViewKinds(...descriptors: readonly ViewKindDescriptor[]): void {
  for (const descriptor of descriptors) {
    if (findViewKind(descriptor.kind) !== null) {
      if (import.meta.env.DEV) {
        throw new Error(`The "${descriptor.kind}" view kind is already registered.`);
      }
      continue;
    }
    registered.push(descriptor);
  }
}

/**
 * What this build knows about a kind, or nothing at all.
 *
 * Returning null rather than a fallback is the whole fail-closed behaviour: a view written by a
 * newer build is reported as undrawable and left untouched, never quietly rendered as something
 * else. The `default` case this replaces did exactly that.
 */
export function findViewKind(kind: string): ViewKindDescriptor | null {
  return VIEW_KINDS.find((descriptor) => descriptor.kind === kind) ?? null;
}

/** Whether this build can draw a kind. */
export function isKnownViewKind(kind: string): boolean {
  return findViewKind(kind) !== null;
}
