import {
  type PropertyOwner,
  type PropertyDefinition,
  type PropertyValue,
} from '../../core/container-model';

export type PropertyInputDensity = 'panel' | 'cell' | 'card';

export interface PropertyInputProps {
  readonly item: PropertyOwner;
  readonly property: PropertyDefinition;

  /**
   * Hands over the value to store for this property. Null clears it, per the merge contract, and
   * this is called once per completed edit rather than once per keystroke.
   */
  readonly onCommit: (value: PropertyValue) => void;

  readonly disabled?: boolean;
  /** Temporary form inputs must not record choice history or upload files. */
  readonly allowInputStorage?: boolean;
  /** Optional removal from the sequential tab order for compact summary-only surfaces. */
  readonly tabIndex?: number;

  /** The server's reason for refusing this property's last write, shown verbatim. */
  readonly error?: string | null;

  /**
   * Where this control is being drawn.
   *
   * `panel` labels itself and draws its own frame. `cell` does neither - the column header is the
   * label, and a framed box inside a ruled cell is a double rule - so it names itself after its
   * row instead, the way a control repeated once per row has to.
   */
  readonly density?: PropertyInputDensity;
}
