import { createContext } from 'react';

export const SettingsNavigationContext = createContext<{
  readonly close: (() => void) | undefined;
  readonly openLayout: () => void;
} | null>(null);
