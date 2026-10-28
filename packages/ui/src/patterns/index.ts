/**
 * The patterns layer: composed pieces that answer a whole interaction rather than draw one thing.
 *
 * Patterns compose controls and primitives. The distinction from a control is not size, it is what
 * the piece knows: a control renders and reports, a pattern owns an interaction's state machine -
 * a highlight and the keys that move it, a selection and how it commits.
 *
 * See `primitives/index.ts` for why each layer carries its own barrel.
 */

export { Listbox, useListbox, type ListboxController, type ListboxOption } from './Listbox';
