import { createContext, useContext } from 'react';

export type ItemDialogContextView =
  | { readonly kind: 'comments' }
  | {
      readonly kind: 'record';
      readonly fields: readonly string[];
      readonly rows: readonly string[];
    }
  | {
      readonly kind: 'review';
      readonly containerId: string;
      readonly coverKey: string | null;
      readonly rows: readonly string[];
    }
  | {
      readonly kind: 'dependencies';
      readonly containerId: string;
      readonly startKey: string;
      readonly endKey: string | null;
    }
  | {
      readonly kind: 'event';
      readonly startKey: string;
      readonly endKey: string | null;
      readonly occurrence?: { readonly start: string; readonly end: string | null };
    };

type OpenItemDialog = (itemId: string, view?: ItemDialogContextView) => void;

export const ItemDialogContext = createContext<OpenItemDialog | null>(null);
export function useItemDialog(): OpenItemDialog | null {
  return useContext(ItemDialogContext);
}
