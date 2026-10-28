import type * as Y from 'yjs';

/**
 * The bridge between a Nix canvas scene and the shared Yjs map the collaboration
 * service validates and stores.
 *
 * **Whole elements, last-writer-wins per element.** Canvas elements are internally
 * consistent objects whose fields depend on each other - merging two versions of one
 * element field-by-field can produce a shape neither author drew - so the unit of merge
 * is the element, and the `version`/`versionNonce` pair decides which write
 * stands: higher version wins, ties break towards the lower nonce, deterministically on
 * every client.
 *
 * The scene lives in `Y.Map('elements')`, element per key, exactly the shape the server's
 * canvas strategy validates. `appState` never syncs - which tool you hold and where your
 * viewport sits are yours - and deleted elements stay as `isDeleted` tombstones, which is
 * which lets a delete win over a concurrent move.
 */

export interface CanvasElement {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly versionNonce: number;
  readonly isDeleted?: boolean;
  /** Fractional z-order index. Sorting by it re-derives draw order. */
  readonly index?: string;
  readonly [key: string]: unknown;
}

export interface CanvasBinding {
  /**
   * Pushes the editor's current scene into the shared map: new and newer elements are
   * written whole, everything the map already has newer stays untouched.
   */
  applyLocal(elements: readonly CanvasElement[]): void;

  /** The merged scene, in draw order, for seeding and re-rendering the editor. */
  snapshot(): CanvasElement[];

  destroy(): void;
}

/** Marks writes made by this binding, so its own observer does not re-render them. */
export const LOCAL_ORIGIN = Symbol('nix.canvas.local');

export const CANVAS_ELEMENTS = 'elements';

/**
 * Binds a document's shared scene: local scenes go in through {@link CanvasBinding.applyLocal},
 * remote changes come out through `onRemoteChange` with the full merged scene.
 */
export function createCanvasBinding(
  doc: Y.Doc,
  onRemoteChange: (elements: CanvasElement[]) => void,
): CanvasBinding {
  const map = doc.getMap<CanvasElement>(CANVAS_ELEMENTS);

  const observer = (_events: unknown, transaction: { origin: unknown }): void => {
    if (transaction.origin === LOCAL_ORIGIN) {
      return;
    }
    onRemoteChange(sceneOf(map));
  };
  map.observe(observer);

  return {
    applyLocal(elements: readonly CanvasElement[]): void {
      doc.transact(() => {
        for (const element of elements) {
          const existing = map.get(element.id);
          if (existing === undefined || supersedes(element, existing)) {
            // Excalidraw elements contain nested points, bindings and group arrays. A shallow
            // clone still lets later renderer mutation alter Yjs without a transaction.
            map.set(element.id, structuredClone(element));
          }
        }
      }, LOCAL_ORIGIN);
    },

    snapshot(): CanvasElement[] {
      return sceneOf(map);
    },

    destroy(): void {
      map.unobserve(observer);
    },
  };
}

/** Whether `candidate` should replace `existing`: newer version, or same version and lower nonce. */
export function supersedes(candidate: CanvasElement, existing: CanvasElement): boolean {
  if (candidate.version !== existing.version) {
    return candidate.version > existing.version;
  }
  return candidate.versionNonce < existing.versionNonce;
}

function sceneOf(map: Y.Map<CanvasElement>): CanvasElement[] {
  // The editor receives an isolated snapshot for the same reason writes are cloned above:
  // renderer-owned nested arrays must never become live references into the CRDT.
  const elements = [...map.values()].map((element) => structuredClone(element));
  // Draw order is the fractional index; elements from builds
  // that carried none sort together at the front, stably by identifier.
  return elements.sort((a, b) => {
    const left = a.index ?? '';
    const right = b.index ?? '';
    if (left === right) {
      return a.id < b.id ? -1 : 1;
    }
    return left < right ? -1 : 1;
  });
}
