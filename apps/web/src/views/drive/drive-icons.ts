import { Blocks, File, FileText, Folder, PenTool, Sheet, type LucideIcon } from 'lucide-react';

import type { Item } from '@nix/web-collections/core/container-model';

/**
 * The glyph a drive row leads with.
 *
 * Chosen from what the item actually is, in this order: whether it holds children, then its own
 * body kind. **Container first, body second** - issue #54's whole point is that a drive is a view
 * over a container's children rather than a folder being a kind of item, so what makes a row read
 * as "a folder" here is that it holds more children, not what its own body happens to be. A note
 * with children still draws as a folder; a note without draws as a note.
 */
export function driveKindIcon(item: Item): LucideIcon {
  if (item.hasChildren) return Folder;

  switch (item.type) {
    case 'file':
      return File;
    case 'spreadsheet':
      return Sheet;
    case 'canvas':
      return PenTool;
    case 'artifact':
      return Blocks;
    case 'note':
      return FileText;
    default:
      // An unrecognised body kind is still a document of some sort, and a generic text glyph says
      // that honestly rather than guessing at a more specific one.
      return FileText;
  }
}

/** Whether a child can hold the sort of thing a "move into" destination has to be. */
export function isDriveContainerCandidate(item: Item): boolean {
  // Every item can in principle hold children, but the drive only offers what already reads as a
  // destination: something that already has children, or something whose body is not a file (a
  // file cannot itself hold children, so it is never a candidate no matter what it says about
  // `hasChildren`).
  return item.hasChildren || item.type !== 'file';
}
