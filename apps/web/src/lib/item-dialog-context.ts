import { createContext, useContext } from 'react';

export const ItemDialogContext = createContext<((itemId: string) => void) | null>(null);
export function useItemDialog(): ((itemId: string) => void) | null {
  return useContext(ItemDialogContext);
}
