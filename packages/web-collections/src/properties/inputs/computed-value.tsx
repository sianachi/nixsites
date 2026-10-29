import { Input, blueprintFrame, cn } from '@nix/ui';
import { PROPERTY_FORMULA_HELP, SHEET_ERROR_CODES, type SheetErrorCode } from '@nix/sheet';
import { type ReactNode } from 'react';

import { rollupAggregateLabel } from '../../core/property-types';
import { readPropertyText, type PropertyDefinition } from '../../core/container-model';

import { type PropertyInputProps } from './types';
import { ValueShell } from './shell';

/**
 * A computed value: the result of a formula, not a field.
 *
 * **An `<output>` rather than a read-only `<input>`, and that is three fixes in one element.** It is
 * a labelable element, so the panel's label still points at it; it is not in the tab order, so a
 * column of three thousand computed cells does not put three thousand dead stops in the keyboard
 * path; and it carries an implicit live region, so a value that changes because somebody edited a
 * different property is announced rather than silently updated. That last one is asserted from the
 * element's semantics rather than proved - settling it needs a real screen reader, which this
 * environment does not have.
 *
 * **An error is shown as an error, with the sentence that says what to do about it.** The value a
 * formula produces can be one of the sheet's error codes, and a bare `#NAME?` in a field called
 * Total reads as a value rather than as a fault to somebody who has never used a spreadsheet. The
 * codes are explained by `PROPERTY_FORMULA_HELP`, which is this surface's own map: three of the
 * grid's sentences are false here, because there is no grid.
 *
 * **The explanation belongs to the panel, not to the table.** A panel shows one value at a time and
 * has room for a sentence; a column repeats whatever it is given once per row, so the expression
 * and the help would print under every cell and grow every row to say what the column header could
 * say once. In a table the code itself is the value, which is what a spreadsheet shows too.
 */
export function ComputedValue(props: PropertyInputProps): ReactNode {
  const { item, property, density = 'panel' } = props;

  const text = readPropertyText(item, property.key);
  const code = (SHEET_ERROR_CODES as readonly string[]).includes(text)
    ? (text as SheetErrorCode)
    : null;

  const source = describeSource(property);

  const panelError = code === null ? null : `${code} - ${PROPERTY_FORMULA_HELP[code]}`;

  return (
    <ValueShell
      {...props}
      error={density === 'cell' ? null : panelError}
      {...(density === 'cell' ? {} : { hint: source })}
    >
      {(control) => (
        <output
          {...control}
          className={cn(
            density === 'cell'
              ? 'block w-full px-2 py-1 font-body text-base text-foreground'
              : cn(
                  blueprintFrame,
                  'block min-w-0 w-full wrap-anywhere bg-background px-3 py-2 font-body text-base text-foreground',
                ),
          )}
        >
          {text}
        </output>
      )}
    </ValueShell>
  );
}

/**
 * Where a computed value comes from, said in one sentence.
 *
 * Not the same sentence for the two computed types, because they do not answer the same question:
 * a formula is about this item and a rollup is about the items inside it, and somebody reading a
 * number they cannot edit needs to know which.
 */
function describeSource(property: PropertyDefinition): string {
  if (property.type === 'rollup') {
    const fold = rollupAggregateLabel(property.aggregate ?? 'count').toLowerCase();
    return property.source == null
      ? `${capitalize(fold)} of the items inside this one.`
      : `${capitalize(fold)} of "${property.source}" across the items inside this one.`;
  }

  return property.expression == null
    ? 'This is a formula property, computed from this item’s other properties.'
    : `Computed from this item’s other properties: ${property.expression}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ReadOnlyValue(props: PropertyInputProps & { readonly note: string }): ReactNode {
  const { item, property, note, density = 'panel' } = props;

  return (
    <ValueShell {...props} hint={note}>
      {(control) => (
        <Input
          {...control}
          tabIndex={props.tabIndex}
          readOnly
          tone={density === 'cell' ? 'plain' : 'default'}
          value={readPropertyText(item, property.key)}
        />
      )}
    </ValueShell>
  );
}
