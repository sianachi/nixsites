import { structure } from '@nix/api-client';
import { useEffect, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import type { PropertyDefinition } from '@nix/web-collections/core/container-model';

/**
 * The effective schema of each container a query's rows live in, by container id. A row is edited
 * with the schema of the container it lives in, never the smart list's own: the same key can be a
 * different type, or carry different options, in another list. A container whose schema has not
 * loaded (or could not be read) is absent, and its rows read as text.
 */
export function useRowSchemas(
  containerIds: readonly string[],
): ReadonlyMap<string, readonly PropertyDefinition[]> {
  const client = useApiClient();
  const [schemas, setSchemas] = useState<ReadonlyMap<string, readonly PropertyDefinition[]>>(
    new Map(),
  );
  const wanted = [...new Set(containerIds)].sort().join(',');

  useEffect(() => {
    const controller = new AbortController();
    for (const id of wanted.split(',').filter((candidate) => candidate.length > 0)) {
      void client
        .query(structure.effectiveSchema(id), { signal: controller.signal })
        .then((schema) => {
          if (controller.signal.aborted) return;
          setSchemas((previous) => new Map(previous).set(id, schema.properties));
        })
        .catch(() => undefined); // shortcut: unreadable schema leaves the row's values read-only text.
    }
    return () => {
      controller.abort();
    };
  }, [client, wanted]);

  return schemas;
}
