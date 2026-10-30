/**
 * The controls layer: things a user operates. Buttons, form controls, tags, cards, navigation,
 * data tables and modals today; the rest of the set as it lands.
 *
 * Controls compose primitives and never reach past them to raw markup for something the layer
 * below already provides. See `primitives/index.ts` for why each layer carries its own barrel.
 */

export { Avatar, initialsOf } from './Avatar';
export { Button } from './Button';
export { Card } from './Card';
export { Checkbox } from './Checkbox';
export { ContextMenu, type ContextMenuTargetProps } from './ContextMenu';
export { Dialog } from './Dialog';
export { Field, type FieldControlProps } from './Field';
export { Input, type InputProps } from './Input';
export { Menu, type MenuAction, type MenuEntry } from './Menu';
export { Popover } from './Popover';
export { useAnchoredPanel } from './use-anchored-panel';
export { PaneDivider } from './PaneDivider';
export { Segmented } from './Segmented';
export { Select } from './Select';
export { Nav } from './Nav';
export { Table, type TableColumn, type TableRowDrag, type TableSort } from './Table';
export { Textarea, type TextareaProps } from './Textarea';
export { Tag, type TagTone } from './Tag';
export { Tabs, type TabItem, type TabsOrientation } from './Tabs';
export { Toast } from './Toast';
