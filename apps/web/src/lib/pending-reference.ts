import { createPendingSlot } from './pending-slot';

/**
 * A reference somebody has asked for but not yet placed.
 *
 * A link between two items is not a row anybody writes: it exists because one item's body mentions
 * the other. So "link A to B" from outside the editor - drawing it on the graph - cannot be
 * completed there without writing into a document the reader is not looking at. It is offered
 * instead: the request waits here, the source item is opened, and its editor shows the reference
 * ready to be put where the reader chooses.
 *
 * Held in memory and for one source at a time. It is an unfinished gesture, not a draft: a reload
 * dropping it is correct, and a second request replaces the first rather than queueing behind it.
 */
export interface PendingReference {
  /** The item whose body will hold the reference. */
  readonly sourceId: string;

  /** The item being referred to. */
  readonly targetId: string;

  /** What the reference is written as - the target's title when it was asked for. */
  readonly label: string;
}

const slot = createPendingSlot<PendingReference>();

export const offerReference = slot.offer;
export const clearPendingReference = slot.clear;

/** The pending reference, as `useSyncExternalStore` wants to read it. */
export const pendingReference = slot.get;

export const onPendingReferenceChanged = slot.subscribe;
