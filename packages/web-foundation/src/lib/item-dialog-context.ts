import { createContext, useContext } from 'react';

type OpenItemDialog = (itemId: string, options?: { readonly showComments: boolean }) => void;

export const ItemDialogContext = createContext<OpenItemDialog | null>(null);
export function useItemDialog(): OpenItemDialog | null {
  return useContext(ItemDialogContext);
}
