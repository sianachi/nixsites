import { z } from 'zod';

import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import type { View } from './graph-camera';
import type { Offset } from './graph-layout';

/**
 * How a reader left the graph, kept on this device.
 *
 * Nudged nodes, folded branches and the camera are all things somebody did on purpose, and losing
 * them on every reload makes arranging the graph pointless. They are kept per workspace in device
 * storage: this is one person's view on one screen, not a fact about the workspace, so it is not
 * sent to the server and another member - or the same person on a phone - sees the plain layout.
 *
 * Everything read back is validated and pruned. Storage is a runtime boundary like any other, and
 * a stale entry naming an item that has since been deleted must not put a ghost offset back.
 */
export interface Arrangement {
  readonly offsets: ReadonlyMap<string, Offset>;
  readonly collapsed: ReadonlySet<string>;
  readonly view: View | null;
}

export const NO_ARRANGEMENT: Arrangement = {
  offsets: new Map(),
  collapsed: new Set(),
  view: null,
};

const STORAGE_KEY = 'nix.graph-arrangement';

const finite = z.number().refine(Number.isFinite);
const STORED = z.record(
  z.string(),
  z.object({
    offsets: z.record(z.string(), z.object({ dx: finite, dy: finite })),
    collapsed: z.array(z.string()),
    // Optional because entries written before views existed carry a `camera` of screen offsets
    // instead. That key is dropped on read, so such an entry opens fitted rather than off-centre.
    view: z
      .object({ centreX: finite, centreY: finite, scale: finite.refine((scale) => scale > 0) })
      .nullable()
      .optional(),
  }),
);

function readAll(): z.infer<typeof STORED> {
  try {
    const raw = browserStorage()?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return {};
    }
    const parsed = STORED.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    // Corrupt JSON, or storage that throws on access. The plain layout is the honest default.
    return {};
  }
}

/** The arrangement kept for a workspace, limited to items that are still in the payload. */
export function readArrangement(workspaceId: string, present: ReadonlySet<string>): Arrangement {
  const stored = readAll()[workspaceId];
  if (stored === undefined) {
    return NO_ARRANGEMENT;
  }

  return {
    offsets: new Map(Object.entries(stored.offsets).filter(([id]) => present.has(id))),
    collapsed: new Set(stored.collapsed.filter((id) => present.has(id))),
    view: stored.view ?? null,
  };
}

/** Keeps an arrangement, or forgets the workspace's entry when there is nothing left to keep. */
export function writeArrangement(workspaceId: string, arrangement: Arrangement): void {
  try {
    const storage = browserStorage();
    if (storage === undefined) {
      return;
    }

    const all = { ...readAll() };
    const empty =
      arrangement.offsets.size === 0 &&
      arrangement.collapsed.size === 0 &&
      arrangement.view === null;

    if (empty) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by workspace id
      delete all[workspaceId];
    } else {
      all[workspaceId] = {
        offsets: Object.fromEntries(arrangement.offsets),
        collapsed: [...arrangement.collapsed],
        view: arrangement.view,
      };
    }

    storage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // A full or refused store. The arrangement simply does not outlive this page.
  }
}
