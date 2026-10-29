import { useEffect, useRef } from 'react';

import { isTypingTarget, matchesShortcut } from '@nix/web-foundation/lib/shortcuts';
import { SHORTCUTS, type ShellShortcutId } from '@nix/web-foundation/keyboard/shortcut-registry';

import type { WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import type { PaneState } from '@nix/web-platform/panes/pane-state';

/**
 * Reveals every item addressed by an open pane once the shell's lazy tree is ready.
 *
 * The tree loads roots first and children on expansion, so a shared link can name an item that is
 * not present yet. Keeping this effect at shell level makes it cover every pane rather than only
 * the active one.
 */
export function useRevealOpenPanes(tree: WorkspaceTree, panes: readonly PaneState[]): void {
  const openIds = panes.map((pane) => pane.itemId).join(' ');

  useEffect(() => {
    if (tree.status !== 'ready') {
      return;
    }

    for (const itemId of openIds.split(' ').filter((id) => id.length > 0)) {
      if (tree.find(itemId) === null) {
        void tree.reveal(itemId);
      }
    }
  }, [openIds, tree]);
}

/**
 * Installs the shell-wide shortcuts in `shortcut-registry.ts` - search, new note, the sidebar,
 * history, and the shortcut sheet - while leaving inner shortcuts alone.
 *
 * Inner controls get first refusal: a key an editor or a menu already handled (`defaultPrevented`)
 * never also fires a global action as it bubbles through the shell. History keys and the bare `?`
 * are also left to text fields and editable content, where `[` and `?` are things people type.
 */
export function useShellShortcuts(actions: Readonly<Record<ShellShortcutId, () => void>>): void {
  // Read by the one listener installed below, so a caller's fresh closures on every render do not
  // re-install it.
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.repeat) {
        return;
      }
      // A dialog is modal: nothing behind it should change while it is open, and a chord that
      // opened search or made a note under the dialog would do exactly that.
      if (hasOpenModal()) {
        return;
      }
      const typing = isTypingTarget(event.target);
      for (const entry of SHORTCUTS) {
        if (entry.handledBy !== 'shell') continue;
        if (!entry.keys.some((keys) => matchesShortcut(event, keys))) continue;
        if (typing && !entry.whileTyping) return;
        event.preventDefault();
        latest.current[entry.id]();
        return;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

/**
 * Escape leaves Zen, but only when it cannot mean anything else.
 *
 * It does not fire when the key was already handled (`defaultPrevented`: a menu, a popover or the
 * editor took it), when focus is in a text field, the note's editor or the canvas (`isTypingTarget`:
 * Escape is how Vim mode leaves Insert, and how a field abandons an edit), with a modifier held,
 * or while any dialog, alert dialog, menu or listbox is on screen, whether or not the key came from
 * inside it. What is left is focus on the page itself, a pane, a button or the file preview.
 */
export function useZenEscape(active: boolean, leave: () => void): void {
  const latest = useRef(leave);
  useEffect(() => {
    latest.current = leave;
  });

  useEffect(() => {
    if (!active) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.isComposing || isTypingTarget(event.target)) return;
      if (
        document.querySelector(
          'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        ) !== null
      ) {
        return;
      }
      event.preventDefault();
      latest.current();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active]);
}

/** Whether a modal dialog owns the current interaction. */
function hasOpenModal(): boolean {
  return document.querySelector('dialog[open], [aria-modal="true"]') !== null;
}
