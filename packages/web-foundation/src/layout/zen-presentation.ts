import { createContext, useContext } from 'react';

interface ZenPresentation {
  readonly collectionTools: boolean;
  readonly noteInsert: boolean;
  readonly noteAdvanced: boolean;
  readonly statusBar: boolean;
}

export const ZenPresentationContext = createContext<ZenPresentation | null>(null);

export function useCompactCollection(): boolean {
  return useContext(ZenPresentationContext)?.collectionTools === false;
}
