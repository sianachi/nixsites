import { Button, Checkbox, ContextMenu, Icon, Input, Select, Text } from '@nix/ui';
import { Maximize, Minus, Pause, Play, Plus, Scan, Shuffle } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
} from 'react';

import { prefersReducedMotion } from '@nix/web-foundation/lib/motion';
import { isPointerCoarse } from '@nix/web-foundation/lib/pointer';
import {
  cameraOf,
  fitCamera,
  panBy,
  viewBoxOf,
  viewOf,
  zoomAbout,
  SCALE_MAX,
  SCALE_MIN,
  type Camera,
  type Size,
  type View,
} from './graph-camera';
import { NO_ARRANGEMENT, readArrangement, writeArrangement } from './graph-arrangement';
import { foldEverything, foldGraph } from './graph-collapse';
import { adjustDecorations, indexDecorations } from './graph-decorations';
import {
  buildAdjacency,
  filterIsActive,
  matchingNodes,
  neighbourhood,
  NO_FILTER,
  type GraphFilter,
} from './graph-emphasis';
import { labelPlacement } from './graph-labels';
import {
  applyOffsets,
  moveEdges,
  nodeRadius,
  nodeTitle,
  type Offset,
  type ParentEdge,
  type PositionedNode,
  type ReferenceEdge,
} from './graph-layout';
import { AT_HOME } from './graph-spring';
import { creationOrder, graphStats, recencyOf, type Recency } from './graph-time';
import { GraphTree } from './graph-tree';
import { stepIn, stepOut } from './graph-zoom';
import { useSprungOffsets } from './use-sprung-offsets';
import { representationScene, type GraphRepresentation } from './graph-representations';
import type { GraphLink, GraphNode } from '@nix/api-client';

/**
 * One workspace, drawn.
 *
 * **There are two representations and both are complete.** The `<svg>` is the picture, and it is
 * `aria-hidden`: a scatter of discs and paths conveys nothing through an accessibility tree, and
 * labelling it `role="img"` with a summary would be claiming otherwise. Beside it is a real tree of
 * buttons carrying the same nodes, the same nesting and - the part a drawing genuinely cannot
 * offer - each node's outgoing references named in words.
 *
 * **That tree is `sr-only`, which is a visual decision and not an accessibility one.** On screen it
 * would be a second copy of the workspace stacked under a picture of the workspace, which is
 * clutter; to a screen reader it is the only form of the graph that can be read at all. Hiding it
 * visually costs sighted readers nothing and removing it would cost everyone else the whole view.
 *
 * **The discs are clickable and draggable; they are not focusable.** Pointer affordances inside an
 * `aria-hidden` subtree are fine - a mouse reaches them and assistive technology is not told they
 * exist, which is honest, because the same actions are on the real buttons in the tree. A
 * `tabIndex` here would not be: a focusable control inside `aria-hidden` is a tab stop that
 * announces nothing, which is worse than either having it or not.
 *
 * **A tap is not a click.** A mouse click and a touch tap land on the same pointer events, but a
 * touch reader never hovered - the label a mouse user sees before committing to open something
 * never showed up for them, so the same gesture that opens a note for one reader is a blind tap for
 * the other. On a coarse pointer the first tap on a node only selects it, writing its name and
 * offering an "Open <title>" button in its place; a second tap on that same node, or the button
 * itself, opens it. A mouse - `matchMedia('(pointer: coarse)')` says no - keeps the one-tap-opens
 * behaviour it always had.
 */

/**
 * When a node writes its name.
 *
 * Labels used to be permanent, and past a few dozen items that is a grey mat of overlapping text
 * rather than a graph - the shape, which is the thing a drawing is for, disappears underneath the
 * words. So a node is a disc until you ask: hover, keyboard focus, tapped-and-selected on a coarse
 * pointer, or being the item that is currently open.
 *
 * Hover is CSS rather than React state on purpose. `group-hover` costs no re-render, and a graph
 * at the 2,000-node ceiling re-rendering every disc on every `mousemove` would be janky for a
 * cosmetic change. Focus and touch selection are React state because both change on a discrete
 * event rather than continuously.
 */
const LABEL_REVEAL = 'opacity-0 transition-opacity group-hover:opacity-100';

/**
 * A node's name: constant on-screen size, with a halo so it reads over edges and other discs.
 *
 * The drawing is scaled by the camera, so the font size is divided by `--zoom` (set on the `<svg>`
 * from the camera) to come out at `text-base` on screen at every zoom. `paint-order: stroke` draws
 * the background-coloured outline under the glyphs. Dimmed nodes fall back to muted text.
 */
const NODE_LABEL =
  'fill-current text-foreground text-[length:calc(var(--text-base)/var(--zoom,1))] [paint-order:stroke] stroke-background stroke-[length:calc(3/var(--zoom,1))] [stroke-linejoin:round]';

/**
 * The disc outline against the drawing's ground.
 *
 * `stroke-divider` measured at roughly 1.4:1 against the surface fill, well under the 3:1 WCAG
 * 1.4.11 asks of a control's boundary. `text-muted` is the token already tuned to reach 3:1 against
 * the page ground in both themes (see the design-token sheet's own comment on the role), so reusing
 * it here rather than inventing a graph-only colour keeps the drawing answerable to the same
 * contrast promise as the rest of the product.
 */
const NODE_STROKE = 'stroke-muted';

/**
 * How far a pointer may travel between press and release and still count as a click.
 *
 * Without a threshold every drag would also open the note it just moved, because a drag ends with a
 * pointer release over the thing it started on. Measured in screen pixels rather than graph units
 * so it means the same thing at every zoom level - it is a statement about the reader's hand, not
 * about the drawing.
 */
const CLICK_SLOP = 4;
const NO_PARENTS: ReadonlySet<string> = new Set();

export interface GraphViewProps {
  readonly representation?: GraphRepresentation;
  readonly focusId?: string | null;
  readonly distance?: number;
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];

  /** Opens an item. Wired to the same `useOpenItem` the tree and the palette use. */
  readonly onOpen: (itemId: string) => void;

  /**
   * A node to bring to the middle of the pane and pick out.
   *
   * The token is what makes it a request rather than a setting: asking for the same node twice is
   * two requests, and the second should move the camera back even though the identifier is equal.
   */
  readonly reveal?: { readonly id: string; readonly token: number } | null;

  /**
   * Whether the server hit a ceiling, so this is part of the workspace rather than all of it.
   *
   * Counts and a replay are both wrong in a quiet way on a partial graph - "12 orphans" may be
   * items whose references were simply not drawn - so anything here that states a number says so.
   */
  readonly partial?: boolean;

  /**
   * The workspace this arrangement belongs to, when it should be kept on this device.
   *
   * Left out, nothing is read or written - which is what a story or a test wants.
   */
  readonly workspaceId?: string | undefined;

  /**
   * Moves an item inside another. Offered when a node is dropped onto a node, after the reader
   * confirms. Left out, dropping a node on another is only a nudge, as it always was.
   */
  readonly onMove?: ((itemId: string, parentId: string) => void) | undefined;

  /**
   * Asks for a reference from one item to another. Offered when the link handle on a node is
   * dragged onto another node. Left out, nodes have no link handle.
   */
  readonly onLink?: ((sourceId: string, targetId: string) => void) | undefined;
}

/**
 * Pointer capture, where the platform has it.
 *
 * Present in every browser this application targets and absent in jsdom, so the feature test is
 * about the test environment rather than about the web. It is still the right shape: capture is an
 * optimisation for a drag - it keeps the events coming when the pointer outruns a small target -
 * and losing it should cost a little precision, never the whole gesture.
 */
function capturePointer(element: Element, pointerId: number): void {
  if (typeof element.setPointerCapture === 'function') {
    element.setPointerCapture(pointerId);
  }
}

function releasePointer(element: Element, pointerId: number): void {
  if (
    typeof element.hasPointerCapture === 'function' &&
    typeof element.releasePointerCapture === 'function' &&
    element.hasPointerCapture(pointerId)
  ) {
    element.releasePointerCapture(pointerId);
  }
}

/** A drag in progress: which node, where the pointer went down, and how far it has come. */
interface Drag {
  readonly id: string;
  readonly startX: number;
  readonly startY: number;
  readonly from: Offset;
  moved: boolean;
}

/**
 * The pane's size before it has been measured, and wherever it cannot be.
 *
 * jsdom has no layout and no `ResizeObserver`, so a test never gets past this; a browser replaces
 * it on the first observation.
 */
const PANE_FALLBACK: Size = { width: 800, height: 560 };

/**
 * How fast a wheel zooms: the scale is multiplied by `e` to the power of this per pixel of wheel.
 *
 * Exponential so equal turns of the wheel are equal ratios - in from 50% to 100% takes the same
 * effort as 100% to 200% - which is what makes zooming feel even across the whole range.
 */
const WHEEL_ZOOM_RATE = 0.0015;

/**
 * How long each ring waits before it leaves the centre, so the entrance goes out as a ripple.
 *
 * A short fixed ladder rather than a delay computed per depth: these are the delay steps the
 * design scale already has, and a workspace deep enough to run past the last one is travelling far
 * enough that the outer rings arriving together is not something anyone can see.
 */
const RING_DELAY = ['delay-0', 'delay-75', 'delay-150', 'delay-200', 'delay-300'] as const;

/**
 * Pushed back while the drawing is picking something else out.
 *
 * Carried by every node that is *not* lit and switched on by one attribute on the `<svg>`. That
 * way round, pointing at a node changes the props of its handful of neighbours and nothing else;
 * the other two thousand are dimmed by the stylesheet without rendering again.
 */
const DIMMED = 'group-data-[dimming]/graph:opacity-25';

const SHAPE = `origin-center fill-surface [transform-box:fill-box] transition-transform group-hover:scale-125 motion-reduce:transition-none`;

/**
 * A node's disc, in the shape of its body kind.
 *
 * Shape rather than colour because the palette has one accent and no categorical set, and because
 * shape survives colour blindness and a greyscale print. A kind this build does not know is a
 * dashed circle: still a node, visibly not one of the named kinds.
 */
/**
 * The outline, by how recently the item was touched.
 *
 * Three discrete states rather than a fade: a reader can tell "today" from "this week" from
 * "neither" at a glance, and could not tell a 40% glow from a 55% one. Weight carries it as well
 * as colour, so it survives without the accent.
 */
const RECENCY_STROKE: Record<Recency, { readonly className: string; readonly width: number }> = {
  today: { className: 'stroke-accent-text', width: 3 },
  week: { className: 'stroke-accent-text', width: 1.5 },
  older: { className: NODE_STROKE, width: 1 },
};

function NodeShape({
  type,
  x,
  y,
  radius,
  recency = 'older',
}: {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly recency?: Recency;
}): ReactElement {
  const outline = RECENCY_STROKE[recency];
  const className = `${SHAPE} ${outline.className}`;

  if (type === 'canvas') {
    return (
      <rect
        x={x - radius}
        y={y - radius}
        width={radius * 2}
        height={radius * 2}
        rx={2}
        strokeWidth={outline.width}
        className={className}
      />
    );
  }

  if (type === 'spreadsheet') {
    // A diamond a little taller than the circle it replaces, so it reads as the same weight.
    const reach = radius * 1.25;
    return (
      <polygon
        points={`${String(x)},${String(y - reach)} ${String(x + reach)},${String(y)} ${String(x)},${String(y + reach)} ${String(x - reach)},${String(y)}`}
        strokeWidth={outline.width}
        className={className}
      />
    );
  }

  return (
    <circle
      cx={x}
      cy={y}
      r={radius}
      strokeWidth={outline.width}
      strokeDasharray={type === 'note' ? undefined : '3 2'}
      className={className}
    />
  );
}

/** What a body kind is called in the legend and the filter. */
function kindLabel(type: string): string {
  return type.length === 0 ? 'Unknown' : `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

/** `none` has no children; `open` shows them; `closed` has folded them into itself. */
type Fold = 'none' | 'open' | 'closed';

interface NodeMarkProps {
  readonly node: PositionedNode;
  readonly centreX: number;

  /** Whether the label is written permanently rather than waiting for a hover. */
  readonly named: boolean;

  /** Whether the label sits on the node's other side because the usual one was taken. */
  readonly flipped: boolean;

  /** Whether a coarse-pointer tap has picked this node and it is offering its "Open" button. */
  readonly selected: boolean;

  /** Whether this node is among the ones currently brought forward. */
  readonly lit: boolean;

  /** How recently it was modified, which its outline shows. */
  readonly recency: Recency;

  /** Not yet arrived in a time-lapse: kept in the tree so its place is held, but not drawn. */
  readonly absent: boolean;

  /** Whether it has children to fold away, and whether they are folded now. */
  readonly fold: Fold;

  /** How many descendants a folded node is standing in for. */
  readonly hiddenCount: number;
  readonly onToggleFold: (itemId: string) => void;

  /** Whether a node or a link being dragged would land on this one if released now. */
  readonly dropTarget: boolean;

  /** Whether this node offers a link handle, and whether a link is being drawn from it now. */
  readonly linkable: boolean;
  readonly linking: boolean;
  readonly onLinkPointerDown: (event: PointerEvent<SVGGElement>, node: PositionedNode) => void;
  readonly onLinkPointerMove: (event: PointerEvent<SVGGElement>) => void;
  readonly onLinkPointerUp: (event: PointerEvent<SVGGElement>) => void;

  /** The entrance transform, until the first frame has passed. */
  readonly home: string | undefined;
  readonly onHover: (itemId: string | null) => void;
  readonly onPointerDown: (event: PointerEvent<SVGGElement>, node: PositionedNode) => void;
  readonly onPointerMove: (event: PointerEvent<SVGGElement>) => void;
  readonly onPointerUp: (event: PointerEvent<SVGGElement>, node: PositionedNode) => void;
  readonly onOpen: (itemId: string) => void;
}

/**
 * One node: its disc, its target, its name.
 *
 * Memoised because of what a drag costs without it. Dragging fires a state change per pointer
 * move, and the node that moved is one of up to 2,000; every other node's props are identical
 * before and after - `applyOffsets` hands back the same object for a node nobody nudged, and the
 * handlers are stable - so this turns a re-render of the whole drawing into a re-render of one mark.
 */
const NodeMark = memo(function NodeMark({
  node,
  centreX,
  named,
  flipped,
  selected,
  lit,
  recency,
  absent,
  fold,
  hiddenCount,
  onToggleFold,
  dropTarget,
  linkable,
  linking,
  onLinkPointerDown,
  onLinkPointerMove,
  onLinkPointerUp,
  home,
  onHover,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onOpen,
}: NodeMarkProps): ReactElement {
  return (
    <g
      data-graph-node={node.id}
      className={`group cursor-default transition-transform duration-500 ease-out motion-reduce:transition-none ${RING_DELAY[Math.min(node.depth, RING_DELAY.length - 1)] ?? ''} ${absent ? 'pointer-events-none' : ''}`}
      transform={home}
      onPointerEnter={() => {
        onHover(node.id);
      }}
      onPointerLeave={() => {
        onHover(null);
      }}
      onPointerDown={(event) => {
        onPointerDown(event, node);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => {
        onPointerUp(event, node);
      }}
    >
      {/* A generous, invisible target under the disc. Seven pixels is a small thing to
          hit with a mouse and smaller with a trackpad, and the alternative - a bigger
          disc - would change the drawing to serve the pointer. */}
      <circle cx={node.x} cy={node.y} r={node.radius * 2.5} className="fill-transparent" />

      {/* The dimming sits on an inner group so its fade is not held back by the ripple's delay,
          which belongs to the entrance and is set on the group above. */}
      <g
        className={`transition-opacity motion-reduce:transition-none ${absent ? 'opacity-0' : lit ? '' : DIMMED}`}
      >
        {/* `transform-box: fill-box` (in SHAPE) makes `origin-center` mean the shape's own
            centre. Without it an SVG element's transform origin is resolved against the viewBox,
            so every disc would grow towards the middle of the drawing instead of in place - and
            the alternative, a computed `transform-origin` per node, is an inline style with two
            raw lengths in it. */}
        <NodeShape type={node.type} x={node.x} y={node.y} radius={node.radius} recency={recency} />
        <text
          {...labelPlacement(node, centreX, flipped)}
          y={node.y}
          dy="0.35em"
          className={`${NODE_LABEL} ${lit ? '' : 'group-data-[dimming]/graph:text-muted'} ${named ? '' : LABEL_REVEAL}`}
        >
          {nodeTitle(node)}
        </text>

        {/* Where a drop would land. A ring outside the disc rather than a change to it, so the
            node keeps saying what kind of item it is while it says "here". */}
        {dropTarget && (
          <circle
            cx={node.x}
            cy={node.y}
            r={node.radius + 6}
            fill="none"
            strokeWidth={2}
            className="stroke-accent-text"
          />
        )}

        {/* The link handle: press here and drag to another node to ask for a reference to it.
            Shown like the fold control - on hover, once a tap has selected the node, and for as
            long as a link is being drawn from it, since the pointer has left the node by then.
            It captures the pointer so the drag keeps reporting here wherever it goes. */}
        {linkable && (
          <g
            data-context-menu-ignore
            className={`cursor-crosshair transition-opacity motion-reduce:transition-none ${
              linking || selected
                ? ''
                : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
            }`}
            onPointerDown={(event) => {
              onLinkPointerDown(event, node);
            }}
            onPointerMove={onLinkPointerMove}
            onPointerUp={onLinkPointerUp}
            onPointerCancel={onLinkPointerUp}
          >
            <circle
              cx={node.x + node.radius}
              cy={node.y + node.radius}
              r={6}
              className="fill-surface stroke-accent-text"
            />
            <polyline
              // An arrow, drawn as a polyline rather than a path: every `<path>` in this drawing
              // is an edge, and the edge tests and styles are entitled to rely on that.
              points={`${String(node.x + node.radius - 3)},${String(node.y + node.radius)} ${String(node.x + node.radius + 3)},${String(node.y + node.radius)} ${String(node.x + node.radius + 0.5)},${String(node.y + node.radius - 2.5)} ${String(node.x + node.radius + 3)},${String(node.y + node.radius)} ${String(node.x + node.radius + 0.5)},${String(node.y + node.radius + 2.5)}`}
              fill="none"
              stroke="currentColor"
              className="text-accent-text"
            />
          </g>
        )}

        {/* The fold control. A folded node always shows it, with the number it is standing in
            for, because that count is the only sign anything is hidden. An open one shows it on
            hover or once a tap has selected the node - on every parent at once it would be a
            second layer of marks over the drawing - and is not a target until it is shown, so a
            touch near a disc's corner cannot fold a branch by accident. `stopPropagation` on
            press keeps the tap from starting a drag of the node. */}
        {fold !== 'none' && (
          <g
            data-context-menu-ignore
            className={`cursor-pointer transition-opacity motion-reduce:transition-none ${
              fold === 'closed' || selected
                ? ''
                : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
            }`}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={() => {
              onToggleFold(node.id);
            }}
          >
            <circle
              cx={node.x + node.radius}
              cy={node.y - node.radius}
              r={6}
              className={`fill-surface ${NODE_STROKE}`}
            />
            <text
              x={node.x + node.radius}
              y={node.y - node.radius + 4}
              textAnchor="middle"
              className="fill-current text-xs text-muted"
            >
              {fold === 'closed' ? '+' : '-'}
            </text>
            {fold === 'closed' && (
              <text
                x={node.x + node.radius + 9}
                y={node.y - node.radius + 4}
                className="fill-current text-xs text-muted"
              >
                {String(hiddenCount)}
              </text>
            )}
          </g>
        )}
      </g>

      {/* Only a coarse-pointer selection reaches this - a mouse opens on its first click
          and never sets a selection. Sized generously rather than tightly around the
          label above it: a button a touch reader has to aim for defeats the point of
          replacing a blind tap with a confirmed one. `stopPropagation` on press keeps this
          button's own tap from being read as the start of a drag on the node underneath
          it. */}
      {selected && (
        <foreignObject
          x={node.x - 56}
          y={node.y + node.radius * 2.5}
          width={112}
          height={28}
          className="overflow-visible"
        >
          <button
            data-context-menu-ignore
            type="button"
            tabIndex={-1}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={() => {
              onOpen(node.id);
            }}
            className="w-full truncate rounded-md bg-accent-fill px-2 py-1 text-center text-xs text-background"
          >
            {`Open ${nodeTitle(node)}`}
          </button>
        </foreignObject>
      )}
    </g>
  );
});

/**
 * How heavy a reference is drawn, from how many times the source makes it.
 *
 * Logarithmic and capped: one mention and two should look different, forty and eighty need not,
 * and no count should produce a line wide enough to hide the nodes it joins.
 */
function referenceWidth(occurrences: number): number {
  return 1.5 + Math.min(Math.log2(Math.max(occurrences, 1)), 3) * 0.6;
}

/** How often the time-lapse steps, and roughly how many steps a whole replay takes. */
const LAPSE_TICK_MS = 60;
const LAPSE_STEPS = 150;

interface EdgeLayerProps {
  readonly parentEdges: readonly ParentEdge[];
  readonly referenceEdges: readonly ReferenceEdge[];
  readonly settled: boolean;

  /** Draw only the references, for a reader who wants the links without the tree under them. */
  readonly hideStructure: boolean;
  readonly emphasizeStructure: boolean;
}

/**
 * Every edge, behind the nodes.
 *
 * Memoised for the same reason the nodes are, against a different gesture: a pan or a zoom changes
 * only the camera, and up to 6,000 paths have no reason to be reconciled for it. `pointer-events`
 * are off so a press on a line falls through to the pane and pans it - an edge is not a control,
 * and a drawing criss-crossed with lines that swallow the drag would be hard to move at all.
 */
const EdgeLayer = memo(function EdgeLayer({
  parentEdges,
  referenceEdges,
  settled,
  hideStructure,
  emphasizeStructure,
}: EdgeLayerProps): ReactElement {
  return (
    // The edges fade in behind the nodes rather than flying with them: a line whose two ends
    // are both moving reads as noise, and there is nothing to follow until the discs land.
    <g
      className={`pointer-events-none transition-opacity duration-500 motion-reduce:transition-none ${settled ? 'opacity-100' : 'opacity-0'}`}
    >
      {/* Containment first, so reference arcs sit over the structure rather than under it. */}
      {!hideStructure && (
        <g
          fill="none"
          stroke="currentColor"
          className={`${emphasizeStructure ? 'text-muted' : 'text-divider'} transition-opacity motion-reduce:transition-none ${DIMMED}`}
        >
          {parentEdges.map((edge) => (
            <path
              key={`${edge.parentId}-${edge.childId}`}
              d={edge.path}
              strokeWidth={1}
              markerEnd="url(#graph-arrow-containment)"
            />
          ))}
        </g>
      )}

      <g
        fill="none"
        stroke="currentColor"
        className={`text-accent-text transition-opacity motion-reduce:transition-none ${DIMMED}`}
      >
        {referenceEdges.map((edge, index) => (
          <path
            key={`${edge.sourceId}-${edge.targetId}-${String(index)}`}
            d={edge.path}
            strokeWidth={referenceWidth(edge.occurrences)}
            markerEnd="url(#graph-arrow-reference)"
          />
        ))}
      </g>
    </g>
  );
});

/** The most reference edges that carry a travelling dot at once. A hub's hundreds would be noise. */
const PULSE_LIMIT = 40;

interface HighlightLayerProps {
  readonly parentEdges: readonly ParentEdge[];
  readonly referenceEdges: readonly ReferenceEdge[];
  readonly pulses: boolean;
}

/**
 * The edges of the node being pointed at, drawn again at full strength over the dimmed rest.
 *
 * A second copy rather than a flag on the originals, so the thousands of edges underneath never
 * render for a hover. On each reference a dot travels from source to target: an arrowhead says
 * which way a link points, and a dot moving along it says so without having to be looked for.
 */
function HighlightLayer({
  parentEdges,
  referenceEdges,
  pulses,
}: HighlightLayerProps): ReactElement {
  return (
    <g className="pointer-events-none" fill="none" stroke="currentColor">
      <g className="text-muted">
        {parentEdges.map((edge) => (
          <path key={`${edge.parentId}-${edge.childId}`} d={edge.path} strokeWidth={1.5} />
        ))}
      </g>
      <g className="text-accent-text">
        {referenceEdges.map((edge, index) => (
          <path
            key={`${edge.sourceId}-${edge.targetId}-${String(index)}`}
            d={edge.path}
            strokeWidth={2.5}
            markerEnd="url(#graph-arrow-reference)"
          />
        ))}
        {pulses &&
          referenceEdges.slice(0, PULSE_LIMIT).map((edge, index) => (
            <circle
              key={`pulse-${edge.sourceId}-${edge.targetId}-${String(index)}`}
              r={3}
              stroke="none"
              className="fill-accent-text"
            >
              <animateMotion dur="1.4s" repeatCount="indefinite" path={edge.path} />
            </circle>
          ))}
      </g>
    </g>
  );
}

/**
 * How much of a dragged node's travel its neighbours follow, and how many of them do.
 *
 * A third is enough to see the links stretch without the neighbourhood leaving its place, and the
 * cap keeps dragging a hub from animating half the workspace.
 */
const PULL = 0.3;
const PULL_LIMIT = 48;

/** A node being dragged, and how far it has come since the press, in graph units. */
interface Pull {
  readonly id: string;
  readonly dx: number;
  readonly dy: number;
}

/** A press on the pane itself: one finger or a mouse pans, two fingers pinch. */
type PaneGesture =
  | {
      readonly kind: 'pan';
      readonly startX: number;
      readonly startY: number;
      readonly from: Camera;
    }
  | {
      readonly kind: 'pinch';
      readonly startDistance: number;
      readonly startMidX: number;
      readonly startMidY: number;
      readonly from: Camera;
    };

export function GraphView(props: GraphViewProps): ReactElement {
  const representation = props.representation ?? 'radial';
  const scope =
    representation === 'focused' ? `${props.focusId ?? ''}:${String(props.distance ?? 1)}` : '';
  return <GraphDrawing key={`${props.workspaceId ?? ''}:${representation}:${scope}`} {...props} />;
}

function GraphDrawing({
  nodes,
  links,
  onOpen,
  reveal,
  partial = false,
  workspaceId,
  onMove,
  onLink,
  representation = 'radial',
  focusId = null,
  distance = 1,
}: GraphViewProps): ReactElement {
  const arrangementId =
    workspaceId === undefined || representation === 'focused'
      ? undefined
      : representation === 'radial'
        ? workspaceId
        : `${workspaceId}:${representation}`;
  // What this reader left behind on this device, read once. Pruned against the payload, so an
  // item deleted since does not bring a ghost offset or a fold with nothing under it back.
  const [stored] = useState(() =>
    arrangementId === undefined
      ? NO_ARRANGEMENT
      : readArrangement(arrangementId, new Set(nodes.map((node) => node.id))),
  );

  // Folding happens to the payload, before layout: what is left is laid out as a workspace of
  // that shape would be, so a fold is a smaller graph rather than a graph with holes in it.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(stored.collapsed);
  const folded = useMemo(() => foldGraph(nodes, links, collapsed), [nodes, links, collapsed]);
  const toggleFold = useCallback((itemId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(itemId)) {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  // Profiled cost is not the reason - the reason is that `layout` is the input to everything below,
  // and laying 2,000 nodes out again on an unrelated re-render (a zoom step, a drag, a hover) would
  // redo the whole walk to produce an identical arrangement. It keys on the folded payload alone.
  // Scene identity keeps panning, zooming and hover from recomputing communities or time lanes.
  const scene = useMemo(
    () => representationScene(folded.nodes, folded.links, representation, focusId, distance),
    [folded, representation, focusId, distance],
  );
  const layout = scene.layout;

  const paneRef = useRef<HTMLDivElement | null>(null);
  const contextNodeId = useRef<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [pane, setPane] = useState<Size>(PANE_FALLBACK);

  useEffect(() => {
    const element = paneRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined && box.width > 0 && box.height > 0) {
        setPane({ width: box.width, height: box.height });
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  /**
   * Where the reader has put the camera, or `null` while they have not.
   *
   * "Fitted" is the absence of a choice rather than a stored camera, so it stays fitted: resizing
   * the pane or reloading a workspace that has grown re-fits by itself, with no effect to keep a
   * copied value in step. The first pan or zoom is what makes it a choice.
   *
   * A choice is kept as a `View` - the graph point at the middle of the pane - so it stays centred
   * however the pane's size changes after it was made.
   */
  const [chosen, setChosen] = useState<View | null>(stored.view);
  const camera = chosen === null ? fitCamera(layout, pane) : cameraOf(chosen, pane);

  const [offsets, setOffsets] = useState<ReadonlyMap<string, Offset>>(stored.offsets);
  const dragRef = useRef<Drag | null>(null);
  const [pull, setPull] = useState<Pull | null>(null);

  // Built once per payload: it answers "what does this node touch" for the highlight, the tug on a
  // dragged node's neighbours, and the labels, and walking 4,000 links again for each would be the
  // same answer at a per-hover price.
  const adjacency = useMemo(
    () => buildAdjacency(layout.nodes, scene.links),
    [layout.nodes, scene.links],
  );

  // Flush completed arrangements on a layout switch, even before the debounce elapses.
  // Temporary offsets from a drag or its neighbour tug are never kept here.
  const lastArrangement = useRef({ offsets, collapsed, view: chosen });
  useEffect(() => {
    if (pull === null) lastArrangement.current = { offsets, collapsed, view: chosen };
  }, [offsets, collapsed, chosen, pull]);
  useEffect(
    () => () => {
      if (arrangementId !== undefined) writeArrangement(arrangementId, lastArrangement.current);
    },
    [arrangementId],
  );

  // Kept a moment after the last change rather than on every one: a wheel or a drag changes the
  // camera or an offset many times a second, and each write serialises the whole entry. Nothing is
  // written mid-drag, when the offsets are still on their way somewhere.
  useEffect(() => {
    if (arrangementId === undefined || pull !== null) {
      return;
    }

    const timer = setTimeout(() => {
      writeArrangement(arrangementId, { offsets, collapsed, view: chosen });
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [arrangementId, offsets, collapsed, chosen, pull]);
  // The camera's zoom for the stylesheet: labels divide their font size by it (see NODE_LABEL).
  // Written to the element rather than rendered, so a zoom tick re-renders no node.
  useLayoutEffect(() => {
    svgRef.current?.style.setProperty('--zoom', String(camera.scale));
  }, [camera.scale]);

  // Where each nudged node is heading: the reader's own nudges, plus - while a node is in the hand
  // - a share of its travel for each neighbour, so the links visibly stretch. The share is dropped
  // on release and the neighbours spring back. Skipped under reduced motion, where it would be a
  // jump out and a jump back.
  const targets = useMemo(() => {
    if (pull === null || prefersReducedMotion()) {
      return offsets;
    }

    const next = new Map(offsets);
    let tugged = 0;
    for (const id of adjacency.get(pull.id) ?? []) {
      if (tugged >= PULL_LIMIT) {
        break;
      }
      tugged += 1;
      const base = offsets.get(id) ?? AT_HOME;
      next.set(id, { dx: base.dx + pull.dx * PULL, dy: base.dy + pull.dy * PULL });
    }
    return next;
  }, [offsets, pull, adjacency]);

  const shownOffsets = useSprungOffsets(targets, pull?.id ?? null);

  // Where the nodes actually are once the reader has nudged any of them, and the edges redrawn to
  // follow. Memoised because identity is the contract here: `NodeMark` and `EdgeLayer` skip their
  // render when handed the same objects, and an untouched graph hands them the layout's own.
  const { positioned, edges } = useMemo(() => {
    if (shownOffsets.size === 0) {
      return { positioned: layout.nodes, edges: layout };
    }

    const nudged = applyOffsets(layout.nodes, shownOffsets);
    const moved = new Map<string, PositionedNode>();
    for (const node of nudged) {
      if (shownOffsets.has(node.id)) {
        moved.set(node.id, node);
      }
    }
    return { positioned: nudged, edges: moveEdges(layout, moved) };
  }, [layout, shownOffsets]);

  // Membership identity is stable between scene changes; dragging visits only nudged members.
  const decorationMembers = useMemo(
    () => indexDecorations(layout.nodes, scene.decorations),
    [layout.nodes, scene.decorations],
  );
  // Preserve unchanged outline identities and skip bounds work in every group-free layout.
  const decorations = useMemo(
    () => adjustDecorations(scene.decorations, decorationMembers, shownOffsets),
    [scene.decorations, decorationMembers, shownOffsets],
  );

  /**
   * Whether the entrance has run.
   *
   * The nodes are rendered at the centre for one frame and then transition out to their rings,
   * which is the explosion the layout describes made visible. A flag flipped in an effect rather
   * than a CSS keyframe because the only `.css` files this project has are the Tailwind entry and
   * the token sheet - a keyframe would be a third.
   */
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSettled(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  // The node the accessible tree's keyboard focus is on, which the drawing labels.
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // The node a coarse-pointer tap has picked out, waiting for the confirming second tap or its own
  // "Open" button. `null` on every other pointer, since a mouse never leaves this set - it opens on
  // the first tap, same as before.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The node under a mouse. React state rather than CSS because the neighbours have to know, and
  // discrete - it changes on entering and leaving a node, not on every pointer move.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // What the reader has asked the drawing to pick out, and the node "find" last landed on.
  const [filter, setFilter] = useState<GraphFilter>(NO_FILTER);
  const [hideStructure, setHideStructure] = useState(false);
  const [foundId, setFoundId] = useState<string | null>(null);

  const matches = useMemo(
    () => (filterIsActive(filter) ? matchingNodes(layout.nodes, filter) : null),
    [layout.nodes, filter],
  );
  const kinds = useMemo(
    () => [...new Set(layout.nodes.map((node) => node.type))].sort(),
    [layout.nodes],
  );

  // One node being pointed at beats a filter: its neighbourhood comes forward. With no node in
  // hand the filter's matches do; with neither, nothing is dimmed at all.
  const activeId = hoveredId ?? focusedId ?? selectedId ?? foundId;
  const lit = useMemo(() => {
    if (activeId !== null) {
      return neighbourhood(adjacency, activeId);
    }
    return matches === null ? null : new Set(matches.map((node) => node.id));
  }, [activeId, adjacency, matches]);

  const activeEdges = useMemo(
    () =>
      activeId === null
        ? null
        : {
            parentEdges: hideStructure
              ? []
              : edges.parentEdges.filter(
                  (edge) => edge.parentId === activeId || edge.childId === activeId,
                ),
            referenceEdges: edges.referenceEdges.filter(
              (edge) => edge.sourceId === activeId || edge.targetId === activeId,
            ),
          },
    [activeId, edges, hideStructure],
  );

  // "Now", fixed for the life of the view. Read once so the recency of every node is judged
  // against the same instant and a re-render cannot move a node from one bucket to another.
  const [now] = useState(() => Date.now());
  const stats = useMemo(() => graphStats(layout.nodes, now), [layout.nodes, now]);

  /**
   * The time-lapse: how many nodes, in creation order, have arrived. `null` is "not replaying".
   *
   * Nodes appear where the finished layout puts them, so the picture grows rather than rearranges
   * - the replay is of this workspace as it stands, ordered by when each surviving item was made,
   * and not a reconstruction of what the graph looked like on a past day.
   */
  const [lapse, setLapse] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const order = useMemo(() => creationOrder(layout.nodes), [layout.nodes]);
  const arrived = useMemo(
    () => (lapse === null ? null : new Set(order.slice(0, lapse).map((node) => node.id))),
    [lapse, order],
  );

  useEffect(() => {
    if (!playing) {
      return;
    }

    const step = Math.max(1, Math.ceil(order.length / LAPSE_STEPS));
    const timer = setInterval(() => {
      setLapse((current) => Math.min((current ?? 0) + step, order.length));
    }, LAPSE_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [playing, order.length]);

  // Reaching the end stops the replay. Decided while rendering rather than inside the interval, so
  // dragging the scrubber to the end while playing stops it too.
  if (playing && lapse !== null && lapse >= order.length) {
    setPlaying(false);
  }

  // The edges drawn during a replay: only those whose two ends have both arrived.
  const drawnEdges = useMemo(
    () =>
      arrived === null
        ? edges
        : {
            parentEdges: edges.parentEdges.filter(
              (edge) => arrived.has(edge.parentId) && arrived.has(edge.childId),
            ),
            referenceEdges: edges.referenceEdges.filter(
              (edge) => arrived.has(edge.sourceId) && arrived.has(edge.targetId),
            ),
          },
    [arrived, edges],
  );
  const latest = lapse === null || lapse === 0 ? undefined : order[lapse - 1];

  /** Puts one node in the middle of the pane, close enough to read, and picks it out. */
  const showNode = (id: string): void => {
    const node = positioned.find((candidate) => candidate.id === id);
    if (node === undefined) {
      return;
    }
    setChosen({ centreX: node.x, centreY: node.y, scale: Math.max(camera.scale, 1) });
    setFoundId(id);
  };

  // A reveal asked for from outside - "Show in graph" on a browse row. Answered while rendering,
  // by comparing against the last token handled, rather than in an effect: the camera is state
  // this component owns, and an effect would paint the old view for a frame before moving it.
  const [handledReveal, setHandledReveal] = useState<number | null>(null);
  if (reveal !== undefined && reveal !== null && reveal.token !== handledReveal) {
    setHandledReveal(reveal.token);
    showNode(reveal.id);
  }

  /**
   * Lands on an item at random - from the filter's matches when there is one, so "Orphans only"
   * turns this into "show me something nothing links to".
   */
  const surprise = (): void => {
    const pool = (matches ?? layout.nodes).filter(
      (node) => arrived === null || arrived.has(node.id),
    );
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick !== undefined) {
      showNode(pick.id);
    }
  };
  const found = foundId === null ? undefined : layout.nodes.find((node) => node.id === foundId);

  /** Steps "find" to the next match, wrapping, so Enter walks every hit in drawing order. */
  const findNext = (): void => {
    if (matches === null || matches.length === 0) {
      return;
    }
    const at = matches.findIndex((node) => node.id === foundId);
    const next = matches[(at + 1) % matches.length];
    if (next !== undefined) {
      showNode(next.id);
    }
  };

  /**
   * What the stable handlers below need to read at the moment they fire.
   *
   * The node handlers are passed to every `NodeMark`, so their identity must not change or the
   * memoisation they exist for is undone on each render. They therefore read the camera, the
   * offsets and the selection from here instead of closing over them.
   */
  const live = useRef({ camera, pane, offsets, selectedId, positioned, onMove, onLink });
  useEffect(() => {
    live.current = { camera, pane, offsets, selectedId, positioned, onMove, onLink };
  });

  // The node a drag would land on if released now, a link being drawn, and a move waiting to be
  // confirmed. A move is asked about rather than done on the drop: the same gesture a few pixels
  // away is only a nudge, and restructuring the workspace should not be something a slip does.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [linking, setLinking] = useState<{
    readonly sourceId: string;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    readonly itemId: string;
    readonly parentId: string;
  } | null>(null);
  const linkRef = useRef<string | null>(null);

  /** A pointer position in the drawing's own coordinates. */
  const toGraph = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    const current = live.current.camera;
    return {
      x: (clientX - (rect?.left ?? 0) - current.x) / current.scale,
      y: (clientY - (rect?.top ?? 0) - current.y) / current.scale,
    };
  }, []);

  /** The node under a point, other than the one being dragged. Nearest wins where two overlap. */
  const nodeAt = useCallback(
    (point: { x: number; y: number }, exceptId: string): PositionedNode | undefined => {
      let best: PositionedNode | undefined;
      let bestDistance = Infinity;
      for (const node of live.current.positioned) {
        if (node.id === exceptId) {
          continue;
        }
        const distance = Math.hypot(node.x - point.x, node.y - point.y);
        if (distance <= node.radius * 2.5 && distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    },
    [],
  );

  /**
   * Where a dragged node could be moved to, if anywhere.
   *
   * Not its current parent, which would be no move at all, and not anything beneath it, which the
   * server refuses as a cycle - refused here too so the drawing never offers a drop it knows
   * cannot happen.
   */
  const moveTargetAt = useCallback(
    (point: { x: number; y: number }, itemId: string): PositionedNode | undefined => {
      const target = nodeAt(point, itemId);
      if (target === undefined || live.current.onMove === undefined) {
        return undefined;
      }

      const nodesNow = live.current.positioned;
      const dragged = nodesNow.find((node) => node.id === itemId);
      if (dragged === undefined || dragged.parentId === target.id) {
        return undefined;
      }

      const parentOf = new Map(nodesNow.map((node) => [node.id, node.parentId]));
      const seen = new Set<string>();
      for (
        let above = parentOf.get(target.id);
        above !== null && above !== undefined && !seen.has(above);
        above = parentOf.get(above)
      ) {
        if (above === itemId) {
          return undefined;
        }
        seen.add(above);
      }

      return target;
    },
    [nodeAt],
  );

  const onLinkPointerDown = useCallback(
    (event: PointerEvent<SVGGElement>, node: PositionedNode): void => {
      if (event.button !== 0) {
        return;
      }
      // Not a drag of the node the handle sits on.
      event.stopPropagation();
      capturePointer(event.currentTarget, event.pointerId);
      linkRef.current = node.id;
      setLinking({ sourceId: node.id, ...toGraph(event.clientX, event.clientY) });
    },
    [toGraph],
  );

  const onLinkPointerMove = useCallback(
    (event: PointerEvent<SVGGElement>): void => {
      const sourceId = linkRef.current;
      if (sourceId === null) {
        return;
      }
      const point = toGraph(event.clientX, event.clientY);
      setLinking({ sourceId, ...point });
      setDropTargetId(nodeAt(point, sourceId)?.id ?? null);
    },
    [toGraph, nodeAt],
  );

  const onLinkPointerUp = useCallback(
    (event: PointerEvent<SVGGElement>): void => {
      const sourceId = linkRef.current;
      linkRef.current = null;
      releasePointer(event.currentTarget, event.pointerId);
      setLinking(null);
      setDropTargetId(null);

      if (sourceId === null) {
        return;
      }
      const target = nodeAt(toGraph(event.clientX, event.clientY), sourceId);
      if (target !== undefined) {
        live.current.onLink?.(sourceId, target.id);
      }
    },
    [toGraph, nodeAt],
  );

  // Written to `live` as well as to state, so two events that arrive inside one frame - a fast
  // wheel does this - build on each other rather than both starting from the last painted camera.
  const moveCamera = useCallback((next: Camera): void => {
    live.current = { ...live.current, camera: next };
    setChosen(viewOf(next, live.current.pane));
  }, []);

  const zoomTo = useCallback(
    (scale: number): void => {
      moveCamera(zoomAbout(live.current.camera, scale, pane.width / 2, pane.height / 2));
    },
    [moveCamera, pane.width, pane.height],
  );
  const onZoomIn = useCallback((): void => {
    zoomTo(stepIn(live.current.camera.scale));
  }, [zoomTo]);
  const onZoomOut = useCallback((): void => {
    zoomTo(stepOut(live.current.camera.scale));
  }, [zoomTo]);

  const open = useCallback(
    (itemId: string): void => {
      setSelectedId(null);
      onOpen(itemId);
    },
    [onOpen],
  );

  // A wheel listener React cannot attach: its `onWheel` is passive, and a passive listener may not
  // `preventDefault`, so the page behind would scroll while the drawing moved. A plain wheel pans,
  // which is what two fingers on a trackpad send; with Ctrl or Cmd held - which is also what a
  // trackpad pinch sends - it zooms about the pointer.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) {
      return;
    }

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const current = live.current.camera;

      if (event.ctrlKey || event.metaKey) {
        const rect = svg.getBoundingClientRect();
        moveCamera(
          zoomAbout(
            current,
            current.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE),
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
        );
        return;
      }

      moveCamera(panBy(current, -event.deltaX, -event.deltaY));
    };

    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
    };
  }, [moveCamera]);

  const onNodePointerDown = useCallback(
    (event: PointerEvent<SVGGElement>, node: PositionedNode): void => {
      // Only the primary button starts a drag; a right-click opens the node's context menu.
      if (event.button !== 0) {
        return;
      }

      // Capture keeps the moves coming when the pointer outruns the disc, which it will - a small
      // target dragged quickly is left behind within a frame. Guarded because it is not universal:
      // jsdom has no pointer capture at all, and an unguarded call there throws before the drag is
      // even recorded, which takes the whole interaction with it rather than only the capture.
      capturePointer(event.currentTarget, event.pointerId);

      dragRef.current = {
        id: node.id,
        startX: event.clientX,
        startY: event.clientY,
        from: live.current.offsets.get(node.id) ?? { dx: 0, dy: 0 },
        moved: false,
      };
    },
    [],
  );

  const onNodePointerMove = useCallback(
    (event: PointerEvent<SVGGElement>): void => {
      const drag = dragRef.current;
      if (drag === null) {
        return;
      }

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP) {
        return;
      }
      drag.moved = true;
      // Horizontal position is a creation timestamp in this representation.
      if (representation === 'chronological') return;

      // Screen pixels into graph units: one screen pixel is exactly `1 / scale` graph units.
      // Without this division a node would run away from the pointer at 300% and lag it at 25%.
      const scale = live.current.camera.scale;
      setDropTargetId(moveTargetAt(toGraph(event.clientX, event.clientY), drag.id)?.id ?? null);
      setPull({ id: drag.id, dx: dx / scale, dy: dy / scale });
      setOffsets((current) => {
        const next = new Map(current);
        next.set(drag.id, { dx: drag.from.dx + dx / scale, dy: drag.from.dy + dy / scale });
        return next;
      });
    },
    [moveTargetAt, toGraph, representation],
  );

  const onNodePointerUp = useCallback(
    (event: PointerEvent<SVGGElement>, node: PositionedNode): void => {
      const drag = dragRef.current;
      dragRef.current = null;
      setPull(null);

      releasePointer(event.currentTarget, event.pointerId);

      setDropTargetId(null);

      // Released on another node: that is a request to move this item inside it, not a nudge. The
      // node goes back to where it was picked up from - if the move is confirmed the workspace is
      // read again and laid out afresh, and if it is declined nothing should have changed.
      const landed =
        drag?.moved === true && representation !== 'chronological'
          ? moveTargetAt(toGraph(event.clientX, event.clientY), drag.id)
          : undefined;
      if (drag !== null && landed !== undefined) {
        setOffsets((current) => {
          const next = new Map(current);
          if (drag.from.dx === 0 && drag.from.dy === 0) {
            next.delete(drag.id);
          } else {
            next.set(drag.id, drag.from);
          }
          return next;
        });
        setPendingMove({ itemId: drag.id, parentId: landed.id });
        return;
      }

      // A release that never travelled is a click, and a click opens the note. A release that did
      // is the end of a drag, and opening the item somebody just finished arranging would be a
      // surprise.
      if (drag === null || drag.moved || drag.id !== node.id) {
        return;
      }

      // A mouse opens on the first tap, as it always has. A coarse pointer never hovered, so the
      // first tap only selects - naming the node and offering an "Open" button - and it takes a
      // second tap on the same node, or that button, to actually leave the graph.
      if (
        (event.pointerType === 'touch' || isPointerCoarse()) &&
        live.current.selectedId !== node.id
      ) {
        setSelectedId(node.id);
        return;
      }

      open(node.id);
    },
    [open, moveTargetAt, toGraph, representation],
  );

  // Presses on the pane itself, as opposed to on a node. Kept by pointer id because a pinch is
  // two of them at once, and the gesture is re-read whenever one arrives or leaves.
  const panePointers = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<PaneGesture | null>(null);

  const readGesture = (): void => {
    const points = [...panePointers.current.values()];
    const from = live.current.camera;
    const [first, second] = points;

    if (first !== undefined && second !== undefined) {
      gestureRef.current = {
        kind: 'pinch',
        startDistance: Math.hypot(second.x - first.x, second.y - first.y) || 1,
        startMidX: (first.x + second.x) / 2,
        startMidY: (first.y + second.y) / 2,
        from,
      };
    } else if (first !== undefined) {
      gestureRef.current = { kind: 'pan', startX: first.x, startY: first.y, from };
    } else {
      gestureRef.current = null;
    }
  };

  const onPanePointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    // Only a press on the empty pane. A press on a node bubbles up to here too, and that one is a
    // drag of the node, not of the drawing.
    if (event.target !== event.currentTarget || event.button !== 0) {
      return;
    }

    capturePointer(event.currentTarget, event.pointerId);
    panePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    readGesture();
  };

  const onPanePointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (!panePointers.current.has(event.pointerId)) {
      return;
    }
    panePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const gesture = gestureRef.current;
    if (gesture === null) {
      return;
    }

    if (gesture.kind === 'pan') {
      moveCamera(
        panBy(gesture.from, event.clientX - gesture.startX, event.clientY - gesture.startY),
      );
      return;
    }

    const [first, second] = [...panePointers.current.values()];
    if (first === undefined || second === undefined) {
      return;
    }

    // The midpoint carries the drawing with the hand; the distance between the fingers scales it
    // about that midpoint. Both are measured from where the pinch began, not from the last event,
    // so rounding does not accumulate over a long gesture.
    const rect = event.currentTarget.getBoundingClientRect();
    const midX = (first.x + second.x) / 2;
    const midY = (first.y + second.y) / 2;
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    const carried = panBy(gesture.from, midX - gesture.startMidX, midY - gesture.startMidY);

    moveCamera(
      zoomAbout(
        carried,
        gesture.from.scale * (distance / gesture.startDistance),
        midX - rect.left,
        midY - rect.top,
      ),
    );
  };

  const onPanePointerEnd = (event: PointerEvent<SVGSVGElement>): void => {
    if (!panePointers.current.delete(event.pointerId)) {
      return;
    }
    releasePointer(event.currentTarget, event.pointerId);
    readGesture();
  };

  const movingNode =
    pendingMove === null ? undefined : nodes.find((node) => node.id === pendingMove.itemId);
  const movingInto =
    pendingMove === null ? undefined : nodes.find((node) => node.id === pendingMove.parentId);
  const linkSource =
    linking === null ? undefined : positioned.find((node) => node.id === linking.sourceId);

  const nudged = offsets.size > 0;

  return (
    <div className="flex min-w-0 flex-col gap-3 break-words">
      {scene.description ? (
        <Text as="p" variant="caption" tone="muted" role="status">
          {scene.description}
          {partial ? ' This view covers the loaded portion of the workspace.' : ''}
        </Text>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="icon"
          aria-label="Zoom out"
          disabled={stepOut(camera.scale) === camera.scale || camera.scale <= SCALE_MIN}
          onClick={onZoomOut}
        >
          <Icon icon={Minus} size="sm" />
        </Button>

        {/* Live, because the two buttons either side change this number and a reader who cannot see
            the drawing rescale has no other way to know the press did anything. */}
        <Text as="span" variant="note" tone="muted" aria-live="polite">
          {`${camera.scale < 0.01 ? (camera.scale * 100).toFixed(1) : String(Math.round(camera.scale * 100))}%`}
        </Text>

        <Button
          variant="icon"
          aria-label="Zoom in"
          disabled={stepIn(camera.scale) === camera.scale || camera.scale >= SCALE_MAX}
          onClick={onZoomIn}
        >
          <Icon icon={Plus} size="sm" />
        </Button>

        <Button
          variant="icon"
          aria-label="Reset zoom"
          disabled={camera.scale === 1}
          onClick={() => {
            zoomTo(1);
          }}
        >
          <Icon icon={Scan} size="sm" />
        </Button>

        {/* Disabled while the drawing is already fitted, which it is until the reader moves it. */}
        <Button
          variant="icon"
          aria-label="Fit graph to view"
          disabled={chosen === null}
          onClick={() => {
            setChosen(null);
          }}
        >
          <Icon icon={Maximize} size="sm" />
        </Button>

        <Button variant="ghost" onClick={surprise}>
          <Icon icon={Shuffle} size="sm" />
          Surprise me
        </Button>

        {representation !== 'focused' && folded.parents.size > 0 && (
          <>
            <Button
              variant="ghost"
              disabled={collapsed.size === 0}
              onClick={() => {
                setCollapsed(new Set());
              }}
            >
              Unfold all
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setCollapsed(foldEverything(nodes));
              }}
            >
              Fold all
            </Button>
          </>
        )}

        {/* Offered only once there is something to undo, and named for what it does rather than
            for the gesture that caused it - somebody who nudged one node an hour ago should not
            have to remember they did to understand this button. */}
        {nudged && (
          <Button
            variant="ghost"
            onClick={() => {
              setOffsets(new Map());
            }}
          >
            Tidy up
          </Button>
        )}
      </div>

      {/* A fixed window onto the drawing. The camera, not a scroller, decides what it shows: the
          drawing can be many times the pane in both directions, and scrollbars are a poor way to
          move around something that size. */}
      <ContextMenu
        label="Graph item actions"
        items={() => {
          const node = nodes.find((candidate) => candidate.id === contextNodeId.current);
          if (node === undefined) return [];
          const drag = dragRef.current;
          dragRef.current = null;
          setPull(null);
          setDropTargetId(null);
          if (drag?.moved) {
            setOffsets((current) => {
              const next = new Map(current);
              if (drag.from.dx === 0 && drag.from.dy === 0) next.delete(drag.id);
              else next.set(drag.id, drag.from);
              return next;
            });
          }
          return [
            {
              label: `Open ${nodeTitle(node)}`,
              onSelect: () => {
                open(node.id);
              },
            },
            {
              label: 'Center in graph',
              onSelect: () => {
                showNode(node.id);
              },
            },
            ...(representation !== 'focused' && folded.parents.has(node.id)
              ? [
                  {
                    label: collapsed.has(node.id) ? 'Unfold branch' : 'Fold branch',
                    onSelect: () => {
                      toggleFold(node.id);
                    },
                  },
                ]
              : []),
          ];
        }}
      >
        {(target) => (
          <div
            {...target}
            ref={paneRef}
            className="h-[60dvh] min-w-0 overflow-hidden rounded-md border border-divider"
            onPointerDownCapture={(event) => {
              contextNodeId.current =
                event.target instanceof Element
                  ? (event.target.closest('[data-graph-node]')?.getAttribute('data-graph-node') ??
                    null)
                  : null;
            }}
            onContextMenuCapture={(event) => {
              contextNodeId.current =
                event.target instanceof Element
                  ? (event.target.closest('[data-graph-node]')?.getAttribute('data-graph-node') ??
                    null)
                  : null;
            }}
          >
            <svg
              ref={svgRef}
              aria-hidden={true}
              focusable="false"
              width="100%"
              height="100%"
              viewBox={viewBoxOf(camera, pane)}
              // Present only while something is picked out; every un-lit mark dims on it (see DIMMED).
              data-dimming={lit === null ? undefined : ''}
              className="group/graph cursor-grab touch-none active:cursor-grabbing"
              onPointerDown={onPanePointerDown}
              onPointerMove={onPanePointerMove}
              onPointerUp={onPanePointerEnd}
              onPointerCancel={onPanePointerEnd}
            >
              {/* Two heads rather than one, because a marker cannot inherit the colour of the path that
              references it: `context-stroke` would do it, but support is uneven enough that a
              containment head would be the wrong colour on some browsers and right on others.

              `orient="auto"` turns the head to the path's own direction at its end, which is what
              makes one definition serve both a straight spoke and a bowed arc. The paths already
              stop short of the disc they point at (see graph-layout.ts), so the head lands in clear
              space rather than under the node. */}
              <defs>
                <marker
                  id="graph-arrow-containment"
                  viewBox="0 0 10 10"
                  refX={9}
                  refY={5}
                  markerWidth={6}
                  markerHeight={6}
                  orient="auto"
                >
                  <path
                    d="M 0 0 L 10 5 L 0 10 z"
                    className={representation === 'hierarchy' ? 'fill-muted' : 'fill-divider'}
                  />
                </marker>
                <marker
                  id="graph-arrow-reference"
                  viewBox="0 0 10 10"
                  refX={9}
                  refY={5}
                  markerWidth={6}
                  markerHeight={6}
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="fill-accent-text" />
                </marker>
              </defs>

              <g pointerEvents="none">
                {decorations.map((decoration, index) => (
                  <g key={`${decoration.kind}:${String(index)}`}>
                    <title>{decoration.label}</title>
                    {decoration.kind === 'group' ? (
                      <rect
                        x={decoration.x}
                        y={decoration.y}
                        width={decoration.width}
                        height={decoration.height}
                        rx={12}
                        className="fill-surface stroke-divider"
                      />
                    ) : null}
                    {decoration.kind === 'time' ? (
                      <line
                        x1={decoration.x}
                        x2={decoration.x}
                        y1={decoration.y + 32}
                        y2={layout.height - 48}
                        className="stroke-divider"
                        strokeDasharray="4 6"
                      />
                    ) : null}
                    <text
                      x={decoration.x + (decoration.kind === 'group' ? 20 : 0)}
                      y={decoration.y + (decoration.kind === 'group' ? 28 : 16)}
                      textAnchor={decoration.anchor ?? 'start'}
                      className="fill-current text-xs text-muted"
                    >
                      {decoration.kind === 'time' || decoration.label.length < 29
                        ? decoration.label
                        : `${decoration.label.slice(0, 26)}…`}
                    </text>
                  </g>
                ))}
              </g>

              <EdgeLayer
                parentEdges={drawnEdges.parentEdges}
                referenceEdges={drawnEdges.referenceEdges}
                settled={settled}
                hideStructure={hideStructure}
                emphasizeStructure={representation === 'hierarchy'}
              />

              {activeEdges !== null && (
                <HighlightLayer
                  // During a replay, an edge to a node that has not arrived yet is not drawn here
                  // either.
                  parentEdges={
                    arrived === null
                      ? activeEdges.parentEdges
                      : activeEdges.parentEdges.filter(
                          (edge) => arrived.has(edge.parentId) && arrived.has(edge.childId),
                        )
                  }
                  referenceEdges={
                    arrived === null
                      ? activeEdges.referenceEdges
                      : activeEdges.referenceEdges.filter(
                          (edge) => arrived.has(edge.sourceId) && arrived.has(edge.targetId),
                        )
                  }
                  pulses={!prefersReducedMotion()}
                />
              )}

              {/* The link being drawn, from its source to the pointer. Dashed, because it is a
              request and not yet a reference. */}
              {linking !== null && linkSource !== undefined && (
                <path
                  d={`M ${String(linkSource.x)} ${String(linkSource.y)} L ${String(linking.x)} ${String(linking.y)}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  className="pointer-events-none text-accent-text"
                />
              )}

              {positioned.map((node) => (
                <NodeMark
                  key={node.id}
                  node={node}
                  centreX={layout.width / 2}
                  named={node.id === hoveredId || node.id === focusedId || node.id === selectedId}
                  flipped={false}
                  selected={node.id === selectedId}
                  lit={lit?.has(node.id) === true}
                  recency={recencyOf(node.lastModifiedAt, now)}
                  absent={arrived !== null && !arrived.has(node.id)}
                  fold={
                    representation !== 'focused' && folded.parents.has(node.id)
                      ? collapsed.has(node.id)
                        ? 'closed'
                        : 'open'
                      : 'none'
                  }
                  hiddenCount={folded.hidden.get(node.id) ?? 0}
                  onToggleFold={toggleFold}
                  dropTarget={node.id === dropTargetId}
                  // A fold stands in for a whole branch, so it cannot hold a reference of its own.
                  linkable={onLink !== undefined && !collapsed.has(node.id)}
                  linking={linking?.sourceId === node.id}
                  onLinkPointerDown={onLinkPointerDown}
                  onLinkPointerMove={onLinkPointerMove}
                  onLinkPointerUp={onLinkPointerUp}
                  onHover={setHoveredId}
                  // Before the first frame every node sits at the middle; afterwards it sits where the
                  // layout put it, and the transition between the two is the explosion.
                  // `motion-reduce` drops the movement for anybody who has asked their system for less
                  // of it - they get the final arrangement immediately.
                  home={
                    settled
                      ? undefined
                      : `translate(${String(layout.width / 2 - node.x)} ${String(layout.height / 2 - node.y)}) scale(0.4)`
                  }
                  onPointerDown={onNodePointerDown}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerUp}
                  onOpen={open}
                />
              ))}
            </svg>
          </div>
        )}
      </ContextMenu>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          className="min-w-0 max-w-full"
          aria-label="Find in graph"
          placeholder="Find in graph"
          value={filter.search}
          onChange={(event) => {
            setFilter({ ...filter, search: event.target.value });
            setFoundId(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              findNext();
            }
          }}
        />
        <Select
          className="min-w-0 max-w-full"
          aria-label="Kind of item"
          value={filter.type ?? ''}
          onChange={(event) => {
            setFilter({ ...filter, type: event.target.value === '' ? null : event.target.value });
            setFoundId(null);
          }}
        >
          <option value="">All kinds</option>
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(kind)}
            </option>
          ))}
        </Select>
        <Checkbox
          label="Orphans only"
          checked={filter.orphansOnly}
          onChange={(event) => {
            setFilter({ ...filter, orphansOnly: event.target.checked });
            setFoundId(null);
          }}
        />
        <Checkbox
          label="Hide structure lines"
          checked={hideStructure}
          onChange={(event) => {
            setHideStructure(event.target.checked);
          }}
        />

        {/* A status, because the drawing dimming is the only other sign a filter did anything,
            and "nothing matched" looks exactly like "everything dimmed". */}
        {/* Where "find" or "Surprise me" landed, in words: the camera moving is not something
            everyone can see. */}
        {found !== undefined && (
          <Text as="span" variant="caption" tone="muted" role="status">
            {`Showing ${nodeTitle(found)}`}
          </Text>
        )}
        {matches !== null && (
          <Text as="span" variant="caption" tone="muted" role="status">
            {matches.length === 0
              ? 'Nothing matches'
              : `${String(matches.length)} matching. Press Enter in Find to step through them.`}
          </Text>
        )}
      </div>

      {/* The key to the two things the discs encode. Words beside each glyph, so the encoding is
          never something a reader has to guess. */}
      <div className="flex flex-wrap items-center gap-3">
        {kinds.map((kind) => (
          <span key={kind} className="flex items-center gap-1">
            <svg aria-hidden={true} focusable="false" width={20} height={20} viewBox="0 0 20 20">
              <NodeShape type={kind} x={10} y={10} radius={nodeRadius(0) - 1} />
            </svg>
            <Text as="span" variant="caption" tone="muted">
              {kindLabel(kind)}
            </Text>
          </span>
        ))}
        <Text as="span" variant="caption" tone="muted">
          Larger means more references. A heavier line is a reference made more than once. An accent
          outline means edited this week; a heavy one, today.
        </Text>
      </div>

      {/* The same facts the drawing shows, as sentences. Text, so they are available to everyone
          by construction, and the most connected item is a button because the obvious next thing
          to want is to see it. */}
      <div className="flex flex-wrap items-center gap-3">
        {stats.mostConnected !== null && (
          <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
            <Text as="span" variant="caption" tone="muted">
              Most connected:
            </Text>
            <Button
              variant="ghost"
              className="min-w-0 max-w-full"
              title={stats.mostConnected.title}
              onClick={() => {
                if (stats.mostConnected !== null) {
                  showNode(stats.mostConnected.id);
                }
              }}
            >
              <span className="truncate">{`${stats.mostConnected.title} (${String(stats.mostConnected.degree)})`}</span>
            </Button>
          </span>
        )}
        <Text as="span" variant="caption" tone="muted">
          {`${String(stats.orphans)} with no references. ${String(stats.editedThisWeek)} edited this week.${partial ? ' Counted over the items drawn, not the whole workspace.' : ''}`}
        </Text>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          onClick={() => {
            if (playing) {
              setPlaying(false);
              return;
            }
            // Starting from the end, or from nothing, means starting over.
            if (lapse === null || lapse >= order.length) {
              setLapse(0);
            }
            setPlaying(true);
          }}
        >
          <Icon icon={playing ? Pause : Play} size="sm" />
          {playing ? 'Pause time-lapse' : 'Play time-lapse'}
        </Button>

        {lapse !== null && (
          <>
            <input
              type="range"
              aria-label="Time-lapse position"
              min={0}
              max={order.length}
              value={lapse}
              onChange={(event) => {
                setLapse(Number(event.target.value));
              }}
              className="w-48 max-w-full"
            />
            <Button
              variant="ghost"
              onClick={() => {
                setPlaying(false);
                setLapse(null);
              }}
            >
              Show everything
            </Button>
            <Text as="span" variant="caption" tone="muted" role="status">
              {`${String(lapse)} of ${String(order.length)} items${latest === undefined ? '' : `, up to ${new Date(latest.createdAt).toLocaleDateString()}`}. Replays the items that exist now, in the order they were created${partial ? ', and only those drawn' : ''}.`}
            </Text>
          </>
        )}
      </div>

      {/* The move a drop asked for, put as a question. Named with both titles so the answer can
          be given without looking back at the drawing. */}
      {pendingMove !== null && movingNode !== undefined && movingInto !== undefined && (
        <div role="group" aria-label="Confirm move" className="flex flex-wrap items-center gap-3">
          <Text as="span" variant="note" role="status">
            {`Move "${nodeTitle(movingNode)}" inside "${nodeTitle(movingInto)}"?`}
          </Text>
          <Button
            variant="secondary"
            onClick={() => {
              onMove?.(pendingMove.itemId, pendingMove.parentId);
              setPendingMove(null);
            }}
          >
            Move
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setPendingMove(null);
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      <GraphTree
        nodes={layout.nodes}
        links={scene.links}
        nodeDescriptions={scene.nodeDescriptions}
        parents={representation === 'focused' ? NO_PARENTS : folded.parents}
        collapsed={collapsed}
        onToggleFold={toggleFold}
        onOpen={open}
        onFocusChange={setFocusedId}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
      />
    </div>
  );
}
