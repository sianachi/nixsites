import { createContext, useContext, type ReactNode } from 'react';

/**
 * Which pane the tree below this point is drawn in.
 *
 * **Why context rather than a prop.** `useViewState` is called by six view components, several of
 * them several levels down - a board reads the sort, a calendar reads the mode, a list writes both.
 * None of them has any business knowing about panes, and threading an index through every one of
 * them would put a parameter on six public component APIs to carry a fact none of them uses for
 * anything except passing it on. A pane index is an ambient coordinate - the answer to "where am
 * I", constant for a whole subtree - which is the one shape context is genuinely for.
 *
 * **The default is the first pane, and that is what makes this a refactor rather than a rewrite.**
 * Every existing caller renders outside any provider, reads 0, and addresses the unprefixed
 * parameters exactly as it did before panes existed.
 */
const PaneIndexContext = createContext(0);

export interface PaneProviderProps {
  /** Zero-based. Pane 0 is the one whose parameters carry no suffix. */
  readonly index: number;
  readonly children: ReactNode;
}

export function PaneProvider({ index, children }: PaneProviderProps): ReactNode {
  // No memo: the value is a number, so a new one is only ever created when it actually changed.
  return <PaneIndexContext.Provider value={index}>{children}</PaneIndexContext.Provider>;
}

/** The pane the caller is being rendered in. Zero outside any provider. */
export function usePaneIndex(): number {
  return useContext(PaneIndexContext);
}
