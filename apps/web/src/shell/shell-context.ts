import type { useWorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';

/**
 * What the shell hands to whatever screen is open.
 *
 * A module of its own rather than an export of `app-shell.tsx`, because its two consumers -
 * `editor-page.tsx` and `document-tab-strip.tsx` - want the type and nothing else. Declaring it
 * beside the component meant every file that named the type imported the whole 575-line shell to
 * reach three lines, and one of those consumers is a leaf component that has no other business
 * knowing the shell exists.
 *
 * The import below is `import type`, so this module contributes no runtime edge to anything: it
 * borrows the tree's shape from the hook that defines it rather than restating it, which would
 * leave two declarations to drift apart.
 */
export interface ShellContext {
  readonly tree: ReturnType<typeof useWorkspaceTree>;
  readonly selectedId: string | null;
  /** Opens the shell's workspace Import dialog, the one the side rail's Import opens. */
  readonly openImport: () => void;
}
