import { items, locks, type NixClient, type pets } from '@nix/api-client';
import { localTimeZone } from '@nix/web-foundation/lib/date-format';

/** The most containers a conversation's first message describes; Core and the worker refuse more. */
export const WORKSPACE_MAP_LIMIT = 40;

/** How many top-level containers have their own children read for the map's second level. Each
 * is one request, so this bounds the work a first message costs on a workspace with many roots. */
const EXPANDED_ROOTS = 8;

/** The limits Core and the worker hold each entry to, in UTF-16 code units (JavaScript's own
 * string length), so a long title is shortened here instead of failing the whole message. */
const TITLE_UNITS = 240;
const TYPE_UNITS = 64;
const VIEW_KIND_UNITS = 40;

/** `text` cut to at most `units` UTF-16 code units, never splitting a surrogate pair. */
export function truncateUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  const cut = text.slice(0, units);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** How long the map may take before the message goes without it. A map is a convenience; a reply
 * waiting on it is not. */
const MAP_TIMEOUT_MS = 3000;

/** The owner's day and zone as the browser knows them, sent with every message so the pet can
 * resolve "tomorrow" or "this Friday" in the owner's own calendar rather than the server's. */
export function ownerTurnContext(now: Date = new Date()): { today: string; timeZone: string } {
  const timeZone = localTimeZone();
  let today: string;
  try {
    // en-CA formats a calendar day as yyyy-MM-dd.
    today = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    today = now.toISOString().slice(0, 10);
  }
  return { today, timeZone };
}

/** View kinds for a container only when this client already holds them: the map never spends a
 * request per container just to name its views. */
function cachedViewKinds(client: NixClient, itemId: string): readonly string[] | undefined {
  for (const key of [
    ['items', itemId, 'views'],
    ['items', itemId, 'view-configurations'],
  ]) {
    const entry = client.cache.peek<{ views?: readonly { kind?: unknown }[] }>(key);
    const views = entry?.data.views;
    if (views !== undefined)
      return views.flatMap((view) => (typeof view.kind === 'string' ? [view.kind] : []));
  }
  return undefined;
}

async function firstPage(
  client: NixClient,
  workspaceId: string,
  parentId: string | undefined,
  signal: AbortSignal,
) {
  const children = [];
  for await (const item of client.paginate(
    items.listItems(workspaceId, { parentId, pageSize: 50 }),
    {
      signal,
      maxPages: 1,
    },
  ))
    children.push(item);
  return children;
}

/**
 * The workspace's main containers for a conversation's first message (plan B.2): every
 * top-level item, then the containers one level below the first few, up to
 * `WORKSPACE_MAP_LIMIT`. Each entry carries the container's id, title and body type, and its view
 * kinds when they are already cached here. Everything comes from reads the owner's own client is
 * allowed to make, so the map can only name what the owner can already see. Resolves to undefined
 * when the reads fail or take longer than `MAP_TIMEOUT_MS`: the message is then sent without it.
 */
export async function buildWorkspaceMap(
  client: NixClient,
  workspaceId: string,
  signal: AbortSignal,
): Promise<pets.PetWorkspaceMapEntry[] | undefined> {
  const timeout = AbortSignal.timeout(MAP_TIMEOUT_MS);
  const bounded = AbortSignal.any([signal, timeout]);
  try {
    const roots = await firstPage(client, workspaceId, undefined, bounded);
    // One container that refuses its listing (a closed lock, say) costs only its own branch.
    // A container under any lock, opened by this session or not, is never expanded: the map
    // reaches the prompt as a conversation starts, which is when the thread's locked-read hold is
    // cleared, so titles from inside a lock would arrive without it (ADR-0050 Amendment 3). A lock
    // state that cannot be read counts as locked.
    const settled = await Promise.allSettled(
      roots
        .filter((root) => root.hasChildren)
        .slice(0, EXPANDED_ROOTS)
        .map(async (root) => {
          const lock = await client.query(locks.getItemLock(root.id), {
            signal: bounded,
            forceRefresh: true,
          });
          if (lock.locked) return [];
          return (await firstPage(client, workspaceId, root.id, bounded)).filter(
            (child) => child.hasChildren,
          );
        }),
    );
    const seconds = settled.flatMap((branch) =>
      branch.status === 'fulfilled' ? branch.value : [],
    );
    return [...roots, ...seconds].slice(0, WORKSPACE_MAP_LIMIT).map((item) => {
      const viewKinds = cachedViewKinds(client, item.id)
        ?.filter((kind) => kind.length <= VIEW_KIND_UNITS)
        .slice(0, 12);
      return {
        id: item.id,
        title: truncateUnits(item.title, TITLE_UNITS),
        type: truncateUnits(item.type, TYPE_UNITS),
        ...(viewKinds === undefined ? {} : { viewKinds }),
      };
    });
  } catch {
    return undefined;
  }
}
