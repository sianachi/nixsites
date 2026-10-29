import { FieldSourceEditor } from '@nix/web-collections/properties/field-source-editor';
import {
  FORMULA_FUNCTION_NAMES,
  PROPERTY_FORMULA_LIMITS,
  propertyFormulaProblem,
} from '@nix/sheet';
import { Button, Field, Icon, Input, Select, Text, cn, fieldLabel, focusRing } from '@nix/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { PropertyDefinition } from '@nix/web-collections/core/container-model';
import { EditorShell } from './editor-shell';
import { LineListInput } from './line-list-input';
import {
  PROPERTY_TYPES,
  ROLLUP_AGGREGATES,
  foldNeedsProperty,
  isComputedType,
  propertyTypeLabel,
} from '@nix/web-collections/core/property-types';
import type { ContainerData } from '@nix/web-collections/core/use-container';

/**
 * Declaring the properties a folder gives its contents.
 *
 * **Bound to what this container declares, never to what it inherits.** The effective schema is
 * the merge of every ancestor's; saving that back would copy the inherited properties onto this
 * item and silently turn inheritance into a copy, after which changing the parent's schema would
 * stop reaching anything below. So the inherited ones are shown, greyed and uneditable, purely so
 * a person can see why a property they did not declare is appearing on their notes.
 *
 * The server is the authority on what is storable and it refuses with a reason naming the property
 * at fault. That reason is shown verbatim rather than being second-guessed here - two validators
 * that disagree is worse than one that is occasionally slower.
 */

export interface SchemaEditorProps {
  readonly container: ContainerData;
  readonly open: boolean;
  readonly onClose: () => void;

  /** Renders as a column in the settings panel rather than as a dialog over the view. */
  readonly inline?: boolean;
}

function hasOptions(type: string): boolean {
  return type === 'select' || type === 'multi_select';
}

/**
 * Every key a formula in this dialog may refer to.
 *
 * **The inherited properties count, and leaving them out was a hint that contradicted the panel
 * below it.** Evaluation reads the *effective* schema, so a property declared three levels up is
 * perfectly referenceable - and this dialog already lists those under "Inherited from above", in
 * the same scroll. A hint that called a key unavailable while the panel underneath showed it would
 * be the exact mistake it exists to prevent.
 */
interface Referenceable {
  readonly here: readonly string[];
  readonly above: readonly string[];
  readonly all: ReadonlySet<string>;
}

/**
 * The key lists, built once per render rather than once per property row.
 *
 * A formula input asks for these on every keystroke, and asking per row made the work quadratic in
 * the number of properties - fine at the ten a schema has today, not fine at forty. The one key a
 * row has to exclude is its own, which {@link exceptSelf} takes off the shared list.
 */
function referenceable(
  drafted: readonly PropertyDefinition[],
  inherited: readonly PropertyDefinition[],
): Referenceable {
  const here = drafted
    .filter((property) => property.key.length > 0)
    .map((property) => property.key);
  const above = inherited.map((property) => property.key);

  return { here, above, all: new Set([...here, ...above]) };
}

/** The same lists without the property doing the asking, which cannot refer to itself. */
function exceptSelf(available: Referenceable, key: string): Referenceable {
  if (key.length === 0 || !available.all.has(key)) {
    return available;
  }

  const here = available.here.filter((candidate) => candidate !== key);
  const above = available.above.filter((candidate) => candidate !== key);

  return { here, above, all: new Set([...here, ...above]) };
}

/** What a formula may refer to, said in the words the person is looking at. */
function referenceHint(available: Referenceable): string {
  const opening = 'Write a property in square brackets, as [estimate] * 2.';

  if (available.here.length === 0 && available.above.length === 0) {
    // Named for what the dialog is about: these are the properties the *children* carry, which is
    // what its own title and lead sentence say.
    return `${opening} Nothing else inside this folder carries a property yet.`;
  }

  const parts: string[] = [];
  if (available.here.length > 0) {
    parts.push(`Available here: ${available.here.map((key) => `[${key}]`).join(', ')}.`);
  }
  if (available.above.length > 0) {
    parts.push(`Inherited: ${available.above.map((key) => `[${key}]`).join(', ')}.`);
  }

  return `${opening} ${parts.join(' ')}`;
}

/** A key derived from a label: lower case, words joined by underscores. */
function keyFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function SchemaEditor({
  container,
  open,
  onClose,
  inline = false,
}: SchemaEditorProps): ReactNode {
  const declared = container.schema?.declared ?? [];
  const effective = container.schema?.properties ?? [];
  const inheritedOnly = effective.filter(
    (property) => !declared.some((own) => own.key === property.key),
  );

  const [draft, setDraft] = useState<readonly PropertyDefinition[]>(declared);
  const [inherit, setInherit] = useState(container.schema?.inherit ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset whenever the dialog opens, so a cancelled edit is not still sitting there next time.
  // Keyed on `open` rather than done in an effect: a render that reads the wrong draft never
  // happens, because the state is replaced before the body is built.
  const [openedWith, setOpenedWith] = useState(open);
  if (open !== openedWith) {
    setOpenedWith(open);
    if (open) {
      setDraft(declared);
      setInherit(container.schema?.inherit ?? true);
      setError(null);
    }
  }

  // Once per render, not once per property row: every formula input reads these on every
  // keystroke, and building them per row made the work quadratic in the number of properties.
  const available = referenceable(draft, inherit ? inheritedOnly : []);

  /**
   * What a rollup may fold.
   *
   * The properties declared here, because a rollup folds the *children's* values and the children
   * carry exactly this schema - which is what this dialog's own title says it is for. A computed
   * property is left out: folding a formula would mean evaluating one per child, which is a
   * dependency walk over rows the server does not hold, and folding a rollup would mean folding a
   * fold. ADR-0044 records why that stays out of scope.
   */
  const foldable = draft
    .filter((property) => property.key.length > 0 && !isComputedType(property.type))
    .map((property) => property.key);

  function update(index: number, change: Partial<PropertyDefinition>): void {
    setDraft((current) =>
      current.map((property, position) =>
        position === index ? { ...property, ...change } : property,
      ),
    );
  }

  async function save(): Promise<void> {
    const pendingSource = draft.find((property) => property.choiceSource?.itemId === '');
    if (pendingSource) {
      setError(`Choose a source note for ${pendingSource.label} before saving.`);
      return;
    }
    setSaving(true);
    setError(null);

    const refusal = await container.setSchema({ properties: draft, inherit });

    setSaving(false);

    if (refusal === null) {
      onClose();
      return;
    }

    setError(refusal);
  }

  return (
    <EditorShell
      inline={inline}
      open={open}
      title="Fields for the items inside this one"
      onClose={onClose}
      onSave={() => {
        void save();
      }}
      saving={saving}
      saveLabel="Save fields"
    >
      <div className="flex flex-col gap-4">
        <Text variant="bodySmall" tone="muted">
          Everything inside this folder can carry these properties, and so can everything inside the
          folders below it.
        </Text>

        {error === null ? null : (
          <Text variant="bodySmall" role="alert" className="border border-foreground px-3 py-2">
            {error}
          </Text>
        )}

        {draft.map((property, index) => (
          <div
            key={index}
            className="@container/field flex min-w-0 flex-col gap-2 border border-divider p-3"
          >
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <Field label="Name" className="flex-1 basis-full @md/field:basis-0">
                {(control) => (
                  <Input
                    {...control}
                    value={property.label}
                    onChange={(event) => {
                      const label = event.target.value;

                      // The key follows the name until the property has been saved once; after
                      // that it is frozen, because values are stored under it and changing it
                      // would orphan every one of them.
                      const isNew = !declared.some((own) => own.key === property.key);
                      const key = isNew ? keyFor(label) : property.key;
                      update(
                        index,
                        isNew
                          ? {
                              label,
                              key,
                              ...(property.choiceSource?.itemId === null &&
                              property.choiceSource.field === property.key
                                ? { choiceSource: { itemId: null, field: key } }
                                : {}),
                            }
                          : { label },
                      );
                    }}
                  />
                )}
              </Field>

              <Field label="Type" className="flex-1">
                {(control) => (
                  <Select
                    {...control}
                    value={property.type}
                    onChange={(event) => {
                      const type = event.target.value;
                      update(index, {
                        type,
                        // Options belong only to the select types, and the server refuses a schema
                        // where anything else carries them.
                        options: hasOptions(type) ? property.options : [],
                        ...(property.choiceSource
                          ? {
                              choiceSource: ['text', 'select', 'multi_select'].includes(type)
                                ? property.choiceSource
                                : null,
                            }
                          : {}),

                        // Same rule for the expression, and the same refusal - but this one also
                        // matters after the fact: an expression left on a property retyped to text
                        // would start evaluating again the moment somebody retyped it back, having
                        // been out of sight in between.
                        expression: type === 'formula' ? (property.expression ?? '') : null,

                        // The fold is the rollup's own, by the same argument: left behind on a
                        // property retyped away, it would start folding again the moment somebody
                        // retyped it back. A rollup arriving with no fold defaults to counting the
                        // children, which is the one fold that needs nothing else chosen.
                        aggregate: type === 'rollup' ? (property.aggregate ?? 'count') : null,
                        source:
                          type === 'rollup' && foldNeedsProperty(property.aggregate ?? 'count')
                            ? (property.source ?? null)
                            : null,

                        // A computed property has no value to require. Left set, the save would be
                        // refused for a box the person ticked before they chose the type.
                        required: isComputedType(type) ? false : property.required,
                      });
                    }}
                  >
                    {PROPERTY_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Button
                variant="icon"
                aria-label={`Remove ${property.label || 'this property'}`}
                onClick={() => {
                  setDraft((current) => current.filter((_, position) => position !== index));
                }}
              >
                <Icon icon={Trash2} size="sm" />
              </Button>
            </div>

            {hasOptions(property.type) ? (
              <Field
                label="Options"
                hint="One per line. A board's columns are chosen separately, so a board can show only some of these."
              >
                {(control) => (
                  <LineListInput
                    {...control}
                    value={property.options}
                    onChange={(options) => {
                      update(index, {
                        options,
                      });
                    }}
                    rows={3}
                  />
                )}
              </Field>
            ) : null}

            {['text', 'select', 'multi_select'].includes(property.type) ? (
              <FieldSourceEditor
                property={property}
                fields={inherit ? [...draft, ...inheritedOnly] : draft}
                onChange={(choiceSource) => {
                  update(index, { choiceSource });
                }}
              />
            ) : null}

            {property.type === 'rollup' ? (
              <RollupFields
                property={property}
                foldable={foldable.filter((key) => key !== property.key)}
                onChange={(change) => {
                  update(index, change);
                }}
              />
            ) : null}

            {property.type === 'formula' ? (
              <FormulaField
                property={property}
                available={exceptSelf(available, property.key)}
                onChange={(expression) => {
                  update(index, { expression });
                }}
              />
            ) : null}

            {/* A computed property is never written, so there is no value for "required" to be
                about. Hidden rather than disabled: a checkbox that cannot mean anything here is a
                question with no answer, and the server refuses a schema that ticks it. */}
            {isComputedType(property.type) ? null : (
              <label className="flex items-center gap-2 text-base">
                <input
                  type="checkbox"
                  checked={property.required}
                  onChange={(event) => {
                    update(index, { required: event.target.checked });
                  }}
                  className={focusRing}
                />
                Required
              </label>
            )}
          </div>
        ))}

        <Button
          variant="secondary"
          onClick={() => {
            setDraft((current) => [
              ...current,
              { key: '', label: '', type: 'text', options: [], required: false },
            ]);
          }}
        >
          <Icon icon={Plus} size="sm" />
          Add a property
        </Button>

        {inheritedOnly.length === 0 ? null : (
          <div className="border-t border-divider pt-3">
            <p className={cn('mb-1', fieldLabel)}>Inherited from above</p>
            {/* Shown but not editable. Somebody needs to see why a property they did not declare is
                appearing on their notes; letting them edit it here would copy it onto this folder
                and quietly sever it from the parent that actually owns it. */}
            <ul className="flex flex-col gap-1">
              {inheritedOnly.map((property) => (
                <Text key={property.key} variant="bodySmall" as="li" tone="muted">
                  {property.label} · {propertyTypeLabel(property.type)}
                </Text>
              ))}
            </ul>

            <label className="mt-2 flex items-center gap-2 text-base">
              <input
                type="checkbox"
                checked={!inherit}
                onChange={(event) => {
                  setInherit(!event.target.checked);
                }}
                className={focusRing}
              />
              Ignore fields from items above this one
            </label>
          </div>
        )}
      </div>
    </EditorShell>
  );
}

/**
 * One formula's expression box.
 *
 * Named per property rather than "Formula", because a schema with three formulas would otherwise
 * put three identically-named textboxes in one dialog - the same problem `PropertyInput` solves for
 * a control repeated once per row, and the same answer.
 */
function FormulaField({
  property,
  available,
  onChange,
}: {
  readonly property: PropertyDefinition;
  readonly available: Referenceable;
  readonly onChange: (expression: string) => void;
}): ReactNode {
  const expression = property.expression ?? '';
  const problem = propertyFormulaProblem(expression, available.all);

  return (
    <Field
      label={`Formula for ${property.label || 'this field'}`}
      hint={`${referenceHint(available)} Use field keys, without a leading =. Functions: ${FORMULA_FUNCTION_NAMES.join(', ')}.`}
      error={problem}
    >
      {(control) => (
        <Input
          {...control}
          value={expression}
          maxLength={PROPERTY_FORMULA_LIMITS.maxLength}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

/**
 * A rollup's two choices: how the children are folded, and which of their properties.
 *
 * **The property list is the schema being edited, because that is what the children carry.** A
 * rollup declared here folds the values of the items inside this one, and those items carry exactly
 * the properties this dialog declares - which is what its own title says. Computed properties are
 * left out: folding a formula would be a dependency walk over rows the server does not hold, and
 * folding a rollup would be folding a fold.
 *
 * **A count is offered alone**, because it is the one fold that answers a question about the
 * container rather than about a property of its contents - "how many things are in here". Choosing
 * it hides the property picker rather than disabling it, for the reason the Required checkbox is
 * hidden on a computed property: a control that cannot mean anything is a question with no answer.
 */
function RollupFields({
  property,
  foldable,
  onChange,
}: {
  readonly property: PropertyDefinition;
  readonly foldable: readonly string[];
  readonly onChange: (change: Partial<PropertyDefinition>) => void;
}): ReactNode {
  const aggregate = property.aggregate ?? 'count';
  const needsProperty = foldNeedsProperty(aggregate);
  const source = property.source ?? '';

  return (
    <div className="flex flex-col gap-2">
      <Field label={`How ${property.label || 'this field'} folds the children`}>
        {(control) => (
          <Select
            {...control}
            value={aggregate}
            onChange={(event) => {
              const next = event.target.value;
              onChange({
                aggregate: next,
                // A count of the children needs no property, and one left behind would be stored
                // against a fold that ignores it - then read back the day somebody changed the
                // fold, having been out of sight in between.
                source: foldNeedsProperty(next) ? (property.source ?? null) : null,
              });
            }}
          >
            {ROLLUP_AGGREGATES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {needsProperty ? (
        <Field
          label={`Which property ${property.label || 'this field'} folds`}
          hint="A property of the items inside this one."
          error={
            source.length === 0
              ? 'Choose a property to fold. Only "How many" can be taken of the children themselves.'
              : null
          }
        >
          {(control) => (
            <Select
              {...control}
              value={source}
              onChange={(event) => {
                onChange({ source: event.target.value.length === 0 ? null : event.target.value });
              }}
            >
              <option value="">Choose a property</option>
              {/* The stored key too, if the schema has moved on since the rollup was written -
                  dropping it would report the rollup as folding something else. */}
              {(source.length > 0 && !foldable.includes(source)
                ? [source, ...foldable]
                : foldable
              ).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
    </div>
  );
}
