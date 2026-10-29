import { createContext, useContext, type ReactNode } from 'react';

import type { TemplateLibrary } from './use-templates';

const TemplateLibraryContext = createContext<TemplateLibrary | null>(null);

export function TemplateLibraryProvider({
  library,
  children,
}: {
  readonly library: TemplateLibrary;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <TemplateLibraryContext.Provider value={library}>{children}</TemplateLibraryContext.Provider>
  );
}

/** Reads the cache-subscribed template state composed by the workspace shell. */
export function useTemplateLibrary(): TemplateLibrary {
  const library = useContext(TemplateLibraryContext);
  if (library === null) {
    throw new Error('Template library state is unavailable outside the workspace shell.');
  }
  return library;
}
