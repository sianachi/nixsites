import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/u);
const coordinate = z.number().min(-100_000).max(100_000);
const dimension = z.number().positive().max(20_000);
const point = z.tuple([coordinate, coordinate]);
const colour = z.string().regex(/^(?:#[0-9a-f]{6}|transparent)$/iu);
const style = z.strictObject({
  strokeColor: colour.optional(),
  backgroundColor: colour.optional(),
  strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  fillStyle: z.enum(['solid', 'hachure', 'cross-hatch', 'zigzag']).optional(),
  strokeWidth: z.number().min(0.5).max(8).optional(),
  opacity: z.number().min(0).max(100).optional(),
});
const common = {
  id,
  groupIds: z.array(id).max(8).optional(),
  style: style.optional(),
};
const box = z.strictObject({
  ...common,
  type: z.enum(['rectangle', 'diamond', 'ellipse']),
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
  nixItemId: z.uuid().nullable().optional(),
});
const text = z.strictObject({
  ...common,
  type: z.literal('text'),
  text: z.string().trim().min(1).max(1_200),
  containerId: id.optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
  fontSize: z.number().min(8).max(96).optional(),
});
const stroke = z.strictObject({
  ...common,
  type: z.enum(['line', 'freedraw']),
  points: z.array(point).min(2).max(1_024),
});
const arrow = z.strictObject({
  ...common,
  type: z.literal('arrow'),
  from: id,
  to: id,
  via: z.array(point).max(16).optional(),
});

export const canvasPlanSchema = z.strictObject({
  elements: z
    .array(z.discriminatedUnion('type', [box, text, stroke, arrow]))
    .max(128)
    .default([]),
  remove: z.array(id).max(128).default([]),
});

export const canvasElementSchema = z.looseObject({
  id: z.string().min(1).max(160),
  type: z.string().min(1),
  version: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 2),
  versionNonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  isDeleted: z.boolean().optional(),
  index: z.string().nullable().optional(),
});

export type CanvasElement = z.infer<typeof canvasElementSchema>;
type Shape = z.infer<typeof box>;
type Label = z.infer<typeof text>;
type Stroke = z.infer<typeof stroke>;
type Arrow = z.infer<typeof arrow>;
type Point = z.infer<typeof point>;
type ElementDraft = Omit<CanvasElement, 'id' | 'version' | 'versionNonce'>;
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Binding {
  elementId: string;
  focus: number;
  gap: number;
}
interface Reference {
  id: string;
  type: 'text' | 'arrow';
}

export const canvasChangeSchema = z.strictObject({
  before: canvasElementSchema.nullable(),
  after: canvasElementSchema,
});
export type CanvasChange = z.infer<typeof canvasChangeSchema>;

const bindingSchema = z.looseObject({ elementId: z.string() });
const positionSchema = z.looseObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  angle: z.number().default(0),
});

function references(element: CanvasElement): string[] {
  if (element.isDeleted) return [];
  if (element.type === 'text')
    return typeof element.containerId === 'string' ? [element.containerId] : [];
  if (element.type !== 'arrow') return [];
  const from = bindingSchema.safeParse(element.startBinding).data?.elementId;
  const to = bindingSchema.safeParse(element.endBinding).data?.elementId;
  return [...new Set([from, to].filter((value): value is string => value !== undefined))];
}

function activeBox(elements: ReadonlyMap<string, CanvasElement>, key: string): CanvasElement {
  const element = elements.get(key);
  if (
    element === undefined ||
    element.isDeleted ||
    !['rectangle', 'diamond', 'ellipse'].includes(element.type)
  )
    throw new Error(`Canvas element ${key} must be a visible rectangle, diamond, or ellipse.`);
  return element;
}

function geometry(points: readonly Point[]): Bounds & { points: Point[] } {
  const origin = points[0];
  if (origin === undefined) throw new Error('A stroke must contain points.');
  const [x, y] = origin;
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  return {
    x,
    y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points: points.map(([px, py]) => [px - x, py - y]),
  };
}

function centre(bounds: Bounds): Point {
  return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
}

function anchor(target: CanvasElement, towards: Point): Point {
  const bounds = positionSchema.parse(target);
  const [cx, cy] = centre(bounds);
  const dx = towards[0] - cx;
  const dy = towards[1] - cy;
  const cosine = Math.cos(bounds.angle);
  const sine = Math.sin(bounds.angle);
  const localX = dx * cosine + dy * sine;
  const localY = -dx * sine + dy * cosine;
  const nx = Math.abs(localX) / (bounds.width / 2);
  const ny = Math.abs(localY) / (bounds.height / 2);
  const divisor =
    target.type === 'diamond'
      ? nx + ny
      : target.type === 'ellipse'
        ? Math.hypot(nx, ny)
        : Math.max(nx, ny);
  if (divisor === 0) throw new Error('Connected elements need different positions.');
  const multiplier = 1 / divisor + 8 / Math.hypot(dx, dy);
  return [cx + dx * multiplier, cy + dy * multiplier];
}

function arrowDraft(spec: Arrow, scene: ReadonlyMap<string, CanvasElement>): ElementDraft {
  if (spec.from === spec.to) throw new Error('A connector needs two distinct elements.');
  const from = activeBox(scene, spec.from);
  const to = activeBox(scene, spec.to);
  const via = spec.via ?? [];
  const start = anchor(from, via[0] ?? centre(positionSchema.parse(to)));
  const end = anchor(to, via.at(-1) ?? centre(positionSchema.parse(from)));
  const binding = (elementId: string): Binding => ({ elementId, focus: 0, gap: 8 });
  return {
    type: 'arrow',
    ...geometry([start, ...via, end]),
    startBinding: binding(spec.from),
    endBinding: binding(spec.to),
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false,
    lastCommittedPoint: null,
  };
}

function labelDraft(spec: Label, scene: ReadonlyMap<string, CanvasElement>): ElementDraft {
  const size = spec.fontSize ?? 20;
  const lines = spec.text.split('\n');
  const width = Math.max(...lines.map((line) => line.length), 1) * size * 0.55;
  const height = lines.length * size * 1.25;
  const container = spec.containerId === undefined ? undefined : activeBox(scene, spec.containerId);
  if (container === undefined && (spec.x === undefined || spec.y === undefined))
    throw new Error(`Text ${spec.id} needs either a containerId or x and y coordinates.`);
  const [cx, cy] = container === undefined ? [0, 0] : centre(positionSchema.parse(container));
  return {
    type: 'text',
    x: container === undefined ? spec.x : cx - width / 2,
    y: container === undefined ? spec.y : cy - height / 2,
    width,
    height,
    text: spec.text,
    originalText: spec.text,
    fontFamily: 1,
    fontSize: size,
    lineHeight: 1.25,
    autoResize: true,
    verticalAlign: container === undefined ? 'top' : 'middle',
    textAlign: container === undefined ? 'left' : 'center',
    containerId: container?.id ?? null,
  };
}

function shapeDraft(spec: Shape): ElementDraft {
  const { type, x, y, width, height, nixItemId } = spec;
  return {
    type,
    x,
    y,
    width,
    height,
    ...(nixItemId === undefined
      ? {}
      : {
          link: nixItemId === null ? null : `nix://item/${nixItemId}`,
          customData: nixItemId === null ? {} : { nix: { kind: 'item', itemId: nixItemId } },
        }),
  };
}

function strokeDraft(spec: Stroke): ElementDraft {
  const path = geometry(spec.points);
  return spec.type === 'line'
    ? {
        type: 'line',
        ...path,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
        lastCommittedPoint: null,
      }
    : {
        type: 'freedraw',
        ...path,
        pressures: [],
        simulatePressure: true,
        lastCommittedPoint: null,
      };
}

export function sameCanvasElement(a: CanvasElement | null, b: CanvasElement | null): boolean {
  return JSON.stringify(orderedJson(a)) === JSON.stringify(orderedJson(b));
}

// Postgres can reorder keys in the durable approval, while Yjs keeps the original native object.
function orderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, orderedJson(entry)]),
  );
}

function nonce(key: string, version: number): number {
  let result = version;
  for (const letter of key) result = Math.imul(result ^ letter.charCodeAt(0), 16_777_619);
  return result >>> 1 || 1;
}

function updateVersion(
  element: CanvasElement,
  current: CanvasElement | null,
  now: number,
): CanvasElement {
  const version = (current?.version ?? 0) + 1;
  return { ...element, version, versionNonce: nonce(element.id, version), updated: now };
}

/** Produces one exact native patch, retaining untouched scene records by identity. */
export function compileCanvasPlan(
  scene: readonly CanvasElement[],
  input: unknown,
  now: number,
): CanvasChange[] {
  const plan = canvasPlanSchema.parse(input);
  const actionIds = [...plan.elements.map((spec) => spec.id), ...plan.remove];
  if (new Set(actionIds).size !== actionIds.length)
    throw new Error('A canvas action can change each element only once.');
  if (actionIds.length === 0) throw new Error('The canvas action contains no changes.');
  const original = new Map(scene.map((element) => [element.id, element]));
  const next = new Map(original);
  const changed = new Set<string>();
  const highIndex = scene.reduce(
    (maximum, element) => (element.index && element.index > maximum ? element.index : maximum),
    'a0',
  );
  let additions = 0;

  const put = (element: CanvasElement) => {
    const prior = original.get(element.id) ?? null;
    if (sameCanvasElement(prior, element)) return;
    if (prior?.locked === true)
      throw new Error(`Canvas element ${element.id} is locked in the drawing.`);
    changed.add(element.id);
    next.set(element.id, element);
  };

  for (const key of plan.remove) {
    const element = next.get(key);
    if (element === undefined || element.isDeleted)
      throw new Error(`Canvas element ${key} could not be removed.`);
    put({ ...element, isDeleted: true });
  }

  const add = (spec: Shape | Label | Stroke | Arrow, draft: ElementDraft) => {
    const prior = original.get(spec.id);
    if (prior !== undefined && prior.type !== spec.type)
      throw new Error(`Canvas element ${spec.id} has a different native type.`);
    const index = prior?.index ?? `${highIndex}${(additions + 1).toString(36).padStart(4, '0')}1`;
    if (prior?.index == null) additions++;
    put(
      canvasElementSchema.parse({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        seed: nonce(spec.id, 1),
        strokeColor: '#1d1f20', // design-token-exempt: persisted drawing colour
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        roundness: null,
        angle: 0,
        frameId: null,
        boundElements: null,
        groupIds: [],
        link: null,
        locked: false,
        version: 0,
        versionNonce: 0,
        updated: now,
        ...prior,
        ...draft,
        ...spec.style,
        id: spec.id,
        index,
        isDeleted: false,
        ...(spec.groupIds === undefined ? {} : { groupIds: [...new Set(spec.groupIds)] }),
      }),
    );
  };

  const ordered = [
    ...plan.elements.filter((spec) => spec.type !== 'arrow' && spec.type !== 'text'),
    ...plan.elements.filter((spec) => spec.type === 'text'),
    ...plan.elements.filter((spec) => spec.type === 'arrow'),
  ];
  for (const spec of ordered) {
    if (spec.type === 'arrow') add(spec, arrowDraft(spec, next));
    else if (spec.type === 'text') add(spec, labelDraft(spec, next));
    else if ('points' in spec) add(spec, strokeDraft(spec));
    else add(spec, shapeDraft(spec));
  }

  // A box's existing label and connectors move with the box even if the plan only changed the box.
  for (const element of original.values()) {
    if (changed.has(element.id) || !references(element).some((target) => changed.has(target)))
      continue;
    if (element.type === 'text' && typeof element.containerId === 'string') {
      if (next.get(element.containerId)?.isDeleted) {
        put({ ...element, isDeleted: true });
      } else if (typeof element.text === 'string') {
        put({
          ...element,
          ...labelDraft(
            {
              id: element.id,
              type: 'text',
              text: element.text,
              containerId: element.containerId,
              ...(typeof element.fontSize === 'number' ? { fontSize: element.fontSize } : {}),
            },
            next,
          ),
        });
      }
    }
    if (element.type !== 'arrow') continue;
    const from = bindingSchema.safeParse(element.startBinding).data?.elementId;
    const to = bindingSchema.safeParse(element.endBinding).data?.elementId;
    if (
      from !== undefined &&
      to !== undefined &&
      next.get(from)?.isDeleted === false &&
      next.get(to)?.isDeleted === false &&
      element.elbowed !== true
    ) {
      const points = z.array(point).safeParse(element.points).data ?? [];
      const position = positionSchema.pick({ x: true, y: true }).parse(element);
      const via: Point[] = points.slice(1, -1).map(([x, y]) => [x + position.x, y + position.y]);
      put({ ...element, ...arrowDraft({ id: element.id, type: 'arrow', from, to, via }, next) });
    } else {
      put({
        ...element,
        ...(from !== undefined && next.get(from)?.isDeleted ? { startBinding: null } : {}),
        ...(to !== undefined && next.get(to)?.isDeleted ? { endBinding: null } : {}),
      });
    }
  }

  const targets = new Set(
    [...changed].flatMap((key) => {
      const before = original.get(key);
      const after = next.get(key);
      return [
        key,
        ...(before === undefined ? [] : references(before)),
        ...(after === undefined ? [] : references(after)),
      ];
    }),
  );
  const bound = new Map<string, Reference[]>();
  for (const element of next.values()) {
    if (element.type !== 'arrow' && element.type !== 'text') continue;
    for (const target of references(element)) {
      if (!targets.has(target)) continue;
      const refs = bound.get(target) ?? [];
      refs.push({ id: element.id, type: element.type });
      bound.set(target, refs);
    }
  }
  for (const target of targets) {
    const element = next.get(target);
    if (element === undefined || element.isDeleted) continue;
    const desired = bound.get(target) ?? null;
    if (JSON.stringify(element.boundElements ?? null) !== JSON.stringify(desired))
      put({ ...element, boundElements: desired });
  }

  return [...changed].flatMap((key) => {
    const before = original.get(key) ?? null;
    const after = next.get(key);
    return after === undefined || sameCanvasElement(before, after)
      ? []
      : [{ before, after: updateVersion(after, before, now) }];
  });
}

/** Undo is based on the affected elements, so an unrelated collaborator's change can survive. */
export function invertCanvasChanges(
  current: readonly CanvasElement[],
  changes: readonly CanvasChange[],
  now: number,
): CanvasChange[] {
  const byId = new Map(current.map((element) => [element.id, element]));
  return changes.map(({ before, after }) => {
    const visible = byId.get(after.id) ?? null;
    if (visible === null || !sameCanvasElement(visible, after))
      throw new Error(`Canvas element ${after.id} changed since this action.`);
    return {
      before: visible,
      after: updateVersion(before ?? { ...visible, isDeleted: true }, visible, now),
    };
  });
}
