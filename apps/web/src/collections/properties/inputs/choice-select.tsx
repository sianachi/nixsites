import { Select, cn, disabledState, focusRing } from '@nix/ui';
import { type ChangeEvent, type ReactNode } from 'react';

import { type ControlProps } from './shell';
import { type PropertyInputDensity } from './types';

/**
 * The select inside a table cell: no frame, because the cell has a rule under it already and a
 * box inside a box reads as a double rule rather than as a control. Kept as a local, hand-inlined
 * class string rather than the `<Select>` primitive because a table row is denser than a form and
 * the primitive has no compact variant; `any-pointer-coarse:h-(--control-lg)` gives touch rows
 * an even height and a 44px touch target, matching what the primitive gives the panel density.
 */
export const cellSelectClasses = cn(
  'min-w-0 w-full border border-transparent bg-transparent px-2 py-1 font-body text-md text-foreground',
  'any-pointer-coarse:h-(--control-lg) any-pointer-coarse:text-lg',
  focusRing,
  disabledState,
);

/** The select every choice editor draws: framed in the panel and on a card, bare in a table cell. */
export function ChoiceSelect(props: {
  readonly density: PropertyInputDensity;
  readonly control: ControlProps;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly children: ReactNode;
  readonly tabIndex?: number | undefined;
  readonly required?: boolean;
  readonly disabled?: boolean;
}): ReactNode {
  const { density, control, value, onChange, children, tabIndex, required, disabled } = props;
  const shared = {
    ...control,
    ...(tabIndex === undefined ? {} : { tabIndex }),
    value,
    required,
    disabled,
    onChange: (event: ChangeEvent<HTMLSelectElement>) => {
      onChange(event.target.value);
    },
  };

  return density === 'cell' ? (
    <select {...shared} className={cellSelectClasses}>
      {children}
    </select>
  ) : (
    <Select {...shared}>{children}</Select>
  );
}
