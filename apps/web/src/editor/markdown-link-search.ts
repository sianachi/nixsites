import type { ListboxOption } from '@nix/ui';
import { FileText } from 'lucide-react';
import { useCallback } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  fetchCandidates,
  itemSearchEmptyMessage,
  RESULT_LIMIT,
  useItemSearch,
} from './item-search';

/** What the `[[` picker in Markdown mode shows for a query: the rich editor's search, unranked. */
export function useNoteLinkSearch(query: string | null): {
  readonly options: readonly ListboxOption[];
  readonly emptyMessage: string;
} {
  const client = useApiClient();
  // Stable, because `useItemSearch` re-runs its effect when this changes.
  const find = useCallback(
    async (text: string, signal: AbortSignal) =>
      (await fetchCandidates(client, text, signal)).slice(0, RESULT_LIMIT),
    [client],
  );
  const { hits, failed, answered } = useItemSearch(query, find);

  return {
    options: hits.map((hit) => ({ id: hit.id, label: hit.title ?? 'Untitled', icon: FileText })),
    emptyMessage: itemSearchEmptyMessage(query ?? '', { failed, answered }),
  };
}
