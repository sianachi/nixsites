import { Button, Field, Icon, Text, fieldLabel } from '@nix/ui';
import { X } from 'lucide-react';
import { useId, type ReactElement, type ReactNode, type RefObject } from 'react';

import { type PropertyOwner, type PropertyDefinition } from '../../core/container-model';

import { type PropertyInputProps, type PropertyInputDensity } from './types';

/**
 * The identifiers a control is handed, whichever shell wired them.
 *
 * A superset of `FieldControlProps`: the panel shell points a visible label at the control by id,
 * the cell shell has no visible label to point and names the control directly instead.
 */
export interface ControlProps {
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
  readonly tabIndex?: number;
}

/**
 * What a control at cell density is called.
 *
 * Named per row rather than per property, matching the board's per-card control exactly: a table of
 * twelve rows would otherwise offer twelve controls all called "Status", and neither a screen reader
 * user nor a test could say which one they were operating.
 */
export function controlName(
  density: PropertyInputDensity,
  item: PropertyOwner,
  property: PropertyDefinition,
): string {
  return density !== 'panel' ? `${property.label} for ${item.title || 'Untitled'}` : property.label;
}

interface ValueShellProps extends PropertyInputProps {
  readonly hint?: string;
  readonly children: (control: ControlProps) => ReactElement;
}

/**
 * The label, the error and the wiring between them - or, in a cell, the absence of all three.
 *
 * The two shells exist so the eight controls below never ask which density they are at for anything
 * but their own box. Everything that differs about *surroundings* differs here, once.
 */
export function ValueShell(props: ValueShellProps): ReactNode {
  const { property, error = null, hint, density = 'panel', children } = props;

  if (density !== 'panel') {
    return <CellShell {...props} />;
  }

  return (
    <Field
      label={property.label}
      required={property.required}
      error={error}
      {...(hint === undefined ? {} : { hint })}
    >
      {children}
    </Field>
  );
}

function CellShell(props: ValueShellProps): ReactNode {
  const { item, property, error = null, hint, density = 'cell', children } = props;

  const id = useId();
  const noteId = `${id}-note`;
  const invalid = error !== null && error.length > 0;

  return (
    <div className="flex flex-col gap-1">
      {children({
        'aria-label': controlName(density, item, property),
        'aria-describedby': invalid || hint !== undefined ? noteId : undefined,
        'aria-invalid': invalid ? true : undefined,
        ...(props.tabIndex === undefined ? {} : { tabIndex: props.tabIndex }),
      })}

      {/* The refusal sits in the cell that caused it and nowhere else. A banner over the table
          would name a property and leave somebody counting rows to find which one. */}
      {invalid ? (
        <Text variant="note" id={noteId} role="alert">
          {error}
        </Text>
      ) : hint === undefined ? null : (
        <Text variant="note" tone="muted" id={noteId}>
          {hint}
        </Text>
      )}
    </div>
  );
}

interface GroupShellProps extends PropertyInputProps {
  readonly hint?: string;
  readonly children: (group: GroupControl) => ReactNode;
}

/** What a control inside a {@link GroupShell} is handed. */
interface GroupControl {
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
  /** The accessible name of one part: its own short name in the panel, `<part> for <name>` elsewhere. */
  readonly name: (part: string, main?: boolean) => string;
}

/**
 * The shell for an editor with more than one control (a date and a time, a time and a zone, a
 * list of checkboxes). One `<fieldset>` names the group, so a screen reader hears the property once
 * and each part by its own short name. The legend is drawn in the panel and only spoken elsewhere,
 * where the column header or the popover already says the word. The hint or the error is one note
 * wired to every control, and the error replaces the hint as `<Field>` does.
 */
export function GroupShell(props: GroupShellProps): ReactNode {
  const {
    item,
    property,
    error = null,
    hint,
    density = 'panel',
    disabled = false,
    children,
  } = props;

  const id = useId();
  const noteId = `${id}-note`;
  const invalid = error !== null && error.length > 0;
  const label = controlName(density, item, property);

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className={density === 'panel' ? fieldLabel : 'sr-only'}>
        {label}
        {property.required ? (
          <span aria-hidden="true" className="ml-1 text-accent-text">
            *
          </span>
        ) : null}
      </legend>

      {children({
        'aria-describedby': invalid || hint !== undefined ? noteId : undefined,
        'aria-invalid': invalid ? true : undefined,
        // Outside the panel the legend is not drawn, so the main control keeps the full name.
        name: (part, main = false) =>
          density === 'panel' ? part : main ? label : `${part} for ${label}`,
      })}

      {invalid ? (
        <Text variant="note" id={noteId} role="alert">
          {error}
        </Text>
      ) : hint === undefined ? null : (
        <Text variant="note" tone="muted" id={noteId}>
          {hint}
        </Text>
      )}
    </fieldset>
  );
}

/**
 * Clears a date-family field and hands focus back to its first input, since the button that had
 * it unmounts with the value. A word in the panel and the card, an icon in a table cell.
 */
export function ClearButton(props: {
  readonly name: string;
  readonly density: PropertyInputDensity;
  readonly disabled: boolean;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onClear: () => void;
}): ReactNode {
  const { name, density, disabled, inputRef, onClear } = props;
  const onClick = (): void => {
    onClear();
    inputRef.current?.focus();
  };

  return density === 'cell' ? (
    <Button variant="subtle" disabled={disabled} aria-label={`Clear ${name}`} onClick={onClick}>
      <Icon icon={X} size="sm" />
    </Button>
  ) : (
    <Button variant="subtle" disabled={disabled} aria-label={`Clear ${name}`} onClick={onClick}>
      Clear
    </Button>
  );
}
