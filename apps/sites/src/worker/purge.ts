import { mapLimited } from '../shared/map-limited.ts';
import type { ObjectTransfer } from '../shared/object-transfer.ts';
import type { CoreClient } from './core-client.ts';
import type { JobContext } from './dispatch.ts';

const PAGE = 500;
const DELETE_CONCURRENCY = 8;

/**
 * One `site.purge` job: delete the objects Core listed (a retired build, or everything of an
 * unpublished site) and tell Core which are gone so it forgets the rows. A delete of an object
 * that is already absent succeeds, so a redelivered job repeats harmlessly.
 */
export async function purgeSite(
  deps: { readonly core: CoreClient; readonly objects: ObjectTransfer },
  context: JobContext,
): Promise<unknown> {
  const { execution, signal } = context;
  let after: string | null = null;
  let removed = 0;
  for (;;) {
    signal.throwIfAborted();
    const page = await deps.core.purgeObjects(execution, after, PAGE, signal);
    await mapLimited(page.objects, DELETE_CONCURRENCY, signal, (target) =>
      deps.objects.delete(target.deleteUrl, signal),
    );
    const deleted = page.objects.map((target) => target.key);
    if (deleted.length > 0) removed += await deps.core.purgeDeleted(execution, deleted, signal);
    if (page.next === null) break;
    after = page.next;
  }
  return { removed };
}
