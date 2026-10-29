import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { App } from '../../app';
import { useGraphOpenPreference } from '../../graph/graph-open-preference';
import { useTabStore } from '@nix/web-foundation/lib/tab-store';

/**
 * The graph destination.
 *
 * Driven through the whole application rather than the view in isolation, because most of what
 * this page promises is only true in a router and against a real fetch: which states it moves
 * through, that opening a node changes the address the same way the tree does, and that the
 * truncation notice reaches a reader.
 *
 * **Every assertion here is on the accessible tree, not the drawing.** That is the point rather
 * than a limitation of jsdom: the `<svg>` is `aria-hidden`, so if a fact about the graph cannot be
 * found by role and name then a screen-reader user cannot find it either. A test that reached into
 * the SVG would be checking the half of the view that is decoration.
 *
 * The tree is `sr-only` - visually hidden, because on screen it would be a second copy of the
 * workspace stacked under a picture of it. Testing Library queries it exactly as before: `sr-only`
 * is a clipping rectangle, not `display: none`, so the node stays in the accessibility tree, which
 * is the whole point of choosing it over removal.
 */
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  signedIn();
  stubViewport(true);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  useGraphOpenPreference.setState({ mode: 'dialog' });
  if (originalScroll === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
});

const ROOT = item({
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  title: 'Specifications',
  hasChildren: true,
});

const CHILD = item({
  id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  title: 'Retention policy',
  parentId: ROOT.id,
});

const OTHER = item({
  id: 'cccccccc-3333-4333-8333-cccccccccccc',
  title: 'Roadmap',
});

function graphTree(): HTMLElement {
  return screen.getByRole('tree', { name: /workspace graph/i });
}

describe('the graph destination', () => {
  it('opens a note deep link as its focused neighborhood on a phone', async () => {
    stubViewport(false);
    stubCoreApi({ items: [ROOT, CHILD, OTHER] });
    renderAt(<App />, `/w/00000000-0000-4000-8000-000000000001/graph?focus=${CHILD.id}`);

    await screen.findByRole('tree', { name: /workspace graph/i });
    expect(screen.getByRole('combobox', { name: 'Graph layout' })).toHaveValue('focused');
    expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue(CHILD.id);
    expect(within(graphTree()).getAllByRole('treeitem')).toHaveLength(2);
    expect(within(graphTree()).queryByRole('button', { name: /Roadmap/ })).not.toBeInTheDocument();
    expect(screen.getByText('Showing Retention policy')).toBeInTheDocument();
  });

  it('reports a focus outside the returned graph while keeping the partial warning', async () => {
    stubCoreApi({ items: [ROOT], graphTruncated: { nodes: true } });
    renderAt(<App />, `/w/00000000-0000-4000-8000-000000000001/graph?focus=${OTHER.id}`);
    await screen.findByRole('tree', { name: /workspace graph/i });
    expect(screen.getByText(/This item is not in the visible graph/)).toBeInTheDocument();
    expect(
      screen.getByText(/Some items, and any references to them, are not drawn/),
    ).toBeInTheDocument();
  });

  it('names every readable item, so the graph is not only a picture', async () => {
    stubCoreApi({ items: [ROOT, CHILD, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const names = within(graphTree())
      .getAllByRole('treeitem')
      .map((row) => row.textContent);

    expect(names).toHaveLength(3);
    expect(names.join(' ')).toContain('Specifications');
    expect(names.join(' ')).toContain('Retention policy');
    expect(names.join(' ')).toContain('Roadmap');
  });

  /**
   * The reason the accessible tree exists at all. A drawing can show an arc between two discs; only
   * words can say which item points at which, and a count alone ("2 references") is the same shrug
   * an unnamed spinner is.
   */
  it('says what each item points at by name, which the drawing cannot', async () => {
    stubCoreApi({
      items: [ROOT, OTHER],
      graphLinks: [{ sourceId: ROOT.id, targetId: OTHER.id }],
    });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(
      within(graphTree()).getByRole('button', { name: /Specifications.*references.*Roadmap/i }),
    ).toBeInTheDocument();
  });

  it('says an item points at nothing rather than leaving it ambiguous', async () => {
    stubCoreApi({ items: [OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(
      within(graphTree()).getByRole('button', { name: /Roadmap.*no references/i }),
    ).toBeInTheDocument();
  });

  it('reports containment depth, so nesting survives without the drawing', async () => {
    stubCoreApi({ items: [ROOT, CHILD] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const rows = within(graphTree()).getAllByRole('treeitem');
    const child = rows.find((row) => row.textContent.includes('Retention policy'));

    expect(child).toHaveAttribute('aria-level', '2');
  });

  it('opens the item in a dialog and preserves the graph', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const roadmap = within(graphTree()).getByRole('treeitem', { name: /Roadmap/i });
    await userEvent.click(within(roadmap).getByRole('button'));

    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('Roadmap');
    const dialog = screen.getByRole('dialog', { name: 'Roadmap' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close item' }));
    expect(graphTree()).toBeInTheDocument();
  });

  /**
   * A roving tabindex is a claim about the document's tab order, and nothing short of tabbing
   * through it checks that. Two thousand nodes behind two thousand tab stops would make the graph
   * something a keyboard user routes around rather than uses.
   */
  it('costs one tab stop, and moves within itself with the arrow keys', async () => {
    stubCoreApi({ items: [ROOT, CHILD, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const rows = within(graphTree()).getAllByRole('button');
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);

    rows[0]?.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows[1]);

    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(rows[rows.length - 1]);

    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(rows[0]);
  });

  it('does not walk past either end of the list', async () => {
    stubCoreApi({ items: [ROOT, CHILD] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const rows = within(graphTree()).getAllByRole('button');
    rows[0]?.focus();
    await userEvent.keyboard('{ArrowUp}');

    expect(document.activeElement).toBe(rows[0]);
  });
});

/**
 * The honest states. A graph has one failure mode a list does not: a truncated list looks short and
 * announces itself, while a truncated graph looks like a graph. Somebody shown part of a workspace
 * would conclude two clusters are unconnected - a wrong answer rather than a missing one.
 */
describe('what the graph admits to', () => {
  it('says so when the node ceiling was reached, rather than drawing a partial graph as whole', async () => {
    stubCoreApi({ items: [ROOT, OTHER], graphTruncated: { nodes: true } });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(await screen.findByRole('status', { name: '' })).toBeInTheDocument();
    expect(screen.getByText(/first 2000 items/i)).toBeInTheDocument();
    expect(screen.getByText(/not drawn/i)).toBeInTheDocument();
  });

  it('reports a link ceiling separately, since the two are independent', async () => {
    stubCoreApi({ items: [ROOT, OTHER], graphTruncated: { links: true } });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(screen.getByText(/first 4000 references/i)).toBeInTheDocument();
  });

  it('claims nothing when the graph is complete', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(screen.queryByText(/not drawn/i)).not.toBeInTheDocument();
  });

  it('offers a way out when the read fails, and does not call it empty', async () => {
    stubCoreApi({ items: [ROOT], graphFails: true });
    renderAt(<App />, '/graph');

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole('tree', { name: /workspace graph/i })).not.toBeInTheDocument();
  });

  /**
   * A regression for a real debugging session. Core answers `404 workspaces.not_found` for a
   * workspace the caller may not see, and a server with no such route answers a bodyless 404 -
   * same status, completely different fact. Reporting the second as the first sent somebody
   * hunting a permission bug that did not exist while the server was simply running an older
   * build.
   */
  it('tells a missing route apart from a refused workspace, since both are 404', async () => {
    stubCoreApi({ items: [ROOT], graphRouteMissing: true });
    renderAt(<App />, '/graph');

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(/older build/i)).toBeInTheDocument();
    expect(within(alert).queryByText(/workspace could not be found/i)).not.toBeInTheDocument();
  });

  it('says a workspace the caller may not see could not be found', async () => {
    stubCoreApi({ items: [ROOT], graphFails: true });
    renderAt(<App />, '/graph');

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(/workspace could not be found/i)).toBeInTheDocument();
    expect(within(alert).queryByText(/older build/i)).not.toBeInTheDocument();
  });

  it('says a workspace with nothing in it is empty, not broken', async () => {
    stubCoreApi({ items: [] });
    renderAt(<App />, '/graph');

    expect(await screen.findByText(/nothing to graph yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/**
 * Zoom.
 *
 * The ladder itself is asserted in `graph-zoom.test.ts`, as arithmetic. What is left here is the
 * part only a rendered view can answer: that the controls exist under names somebody can find,
 * that they report where they got to, and that they stop at the ends rather than going quiet.
 */
describe('zooming the graph', () => {
  it('shows the drawing before the secondary controls so it is visible on a phone', async () => {
    stubCoreApi({ items: [ROOT, CHILD, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const drawing = container.querySelector('svg[class~="group/graph"]');
    const find = screen.getByRole('searchbox', { name: 'Find in graph' });

    if (drawing === null) {
      throw new Error('the spatial graph drawing was not rendered');
    }

    expect(drawing.compareDocumentPosition(find) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers named controls rather than bare glyphs', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset zoom/i })).toBeInTheDocument();
  });

  it('says where the zoom got to, since the drawing rescaling is not something everyone can see', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });
    expect(screen.getByText('100%')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(screen.getByText('150%')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /zoom out/i }));
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('returns to where it started, exactly', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    await userEvent.click(screen.getByRole('button', { name: /reset zoom/i }));

    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('disables reset at the default, so the control never lies about having something to do', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(screen.getByRole('button', { name: /reset zoom/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(screen.getByRole('button', { name: /reset zoom/i })).toBeEnabled();
  });

  it('stops at the ends rather than stepping past them', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const zoomIn = screen.getByRole('button', { name: /zoom in/i });
    for (let step = 0; step < 8; step += 1) {
      if (!zoomIn.hasAttribute('disabled')) {
        await userEvent.click(zoomIn);
      }
    }

    expect(screen.getByText('300%')).toBeInTheDocument();
    expect(zoomIn).toBeDisabled();
  });
});

/**
 * Labels.
 *
 * **The one place these tests read the drawing**, and worth saying why. Labels used to be
 * permanent, and past a few dozen items that is a mat of overlapping text with the shape lost
 * underneath - so a node writes its name only when asked. That is a fact about the SVG and there is
 * nowhere else to look for it.
 *
 * The assertion is on the reveal class rather than on computed visibility, because jsdom does not
 * run Tailwind: no stylesheet is attached, so `getComputedStyle` reports nothing useful for
 * `opacity-0` or `group-hover`. This therefore catches the behaviour being deleted or inverted, and
 * does not prove a hover actually paints - which needs the browser-based pass (Storybook + axe),
 * the same limit `sidebar-drawer.test.tsx` records for its own.
 */
describe('when a node writes its name', () => {
  function labelFor(container: HTMLElement, title: string): SVGTextElement | undefined {
    return [...container.querySelectorAll('svg text')].find(
      (text) => text.textContent === title,
    ) as SVGTextElement | undefined;
  }

  it('keeps every name in the drawing, so nothing is unfindable', async () => {
    const { container } = renderAt(<App />, '/graph');
    stubCoreApi({ items: [ROOT, OTHER] });

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(labelFor(container, 'Specifications')).toBeDefined();
    expect(labelFor(container, 'Roadmap')).toBeDefined();
  });

  it('keeps a node label hidden until hover even when there is room for it', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    expect(labelFor(container, 'Roadmap')?.getAttribute('class')).toContain('opacity-0');
  });

  /**
   * The reason the drawing tracks keyboard focus at all. The tree is `sr-only`, so a sighted
   * keyboard user is focused on a control they cannot see - and without this the graph would give
   * them no indication of where they are.
   */
  it('names the node the keyboard is on, since the control itself is not painted', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const rows = within(screen.getByRole('tree', { name: /workspace graph/i })).getAllByRole(
      'button',
    );
    const firstName = rows[0]?.textContent.split(',')[0] ?? '';
    rows[0]?.focus();

    // Awaited because focus sets React state: the re-render that reveals the label happens after
    // the event, not during `.focus()`.
    await waitFor(() => {
      expect(labelFor(container, firstName)?.getAttribute('class')).not.toContain('opacity-0');
    });
  });
});

/**
 * Arrowheads.
 *
 * Reads the drawing, for the same reason the label tests do: direction is a fact about the SVG and
 * there is nowhere else to look for it. The marker geometry is not asserted - that is a picture,
 * and jsdom paints nothing - but whether every edge actually references a head is structural, and
 * an edge that quietly lost its `marker-end` would otherwise look exactly like one that has it.
 */
describe('showing which way an edge points', () => {
  it('puts a head on every containment edge and every reference edge', async () => {
    stubCoreApi({
      items: [ROOT, CHILD, OTHER],
      graphLinks: [{ sourceId: ROOT.id, targetId: OTHER.id }],
    });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const paths = [...container.querySelectorAll('svg g path')];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.getAttribute('marker-end') !== null)).toBe(true);
  });

  it('defines the heads it points at, so no edge references a marker that is not there', async () => {
    stubCoreApi({
      items: [ROOT, CHILD, OTHER],
      graphLinks: [{ sourceId: ROOT.id, targetId: OTHER.id }],
    });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const referenced = new Set(
      [...container.querySelectorAll('svg g path')].map((path) =>
        (path.getAttribute('marker-end') ?? '').replace(/^url\(#|\)$/g, ''),
      ),
    );
    const defined = new Set(
      [...container.querySelectorAll('svg defs marker')].map((marker) => marker.id),
    );

    expect(referenced.size).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(defined).toContain(id);
    }
  });
});

/**
 * Clicking and dragging the discs themselves.
 *
 * Driven with pointer events rather than `userEvent.click`, because that is what the view listens
 * for - and because the distinction under test is entirely about how far the pointer travelled
 * between press and release, which a synthesised click has no way to express.
 *
 * jsdom implements no pointer capture at all. The handlers feature-test for it, so these tests
 * exercise the no-capture path as a side effect - which is worth knowing when reading a failure
 * here, and is how the missing guard was found in the first place.
 */
describe('handling a node with the pointer', () => {
  function discFor(container: HTMLElement, index: number): SVGGElement {
    const groups = [...container.querySelectorAll('svg > g.group')];
    const group = groups[index];
    if (group === undefined) {
      throw new Error(`no node group at ${String(index)}`);
    }
    return group as SVGGElement;
  }

  function press(target: Element, x: number, y: number): void {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: x, clientY: y });
  }

  it('opens the note when a disc is clicked', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const disc = discFor(container, 0);
    press(disc, 100, 100);
    fireEvent.pointerUp(disc, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue(
      'Specifications',
    );
  });

  /**
   * The reason a threshold exists at all. A drag ends with a pointer release over the node it
   * started on, so without one, arranging the graph would open a note every time.
   */
  it('does not open the note when the disc was dragged instead of clicked', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const disc = discFor(container, 0);
    press(disc, 100, 100);
    fireEvent.pointerMove(disc, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(disc, { pointerId: 1, clientX: 160, clientY: 140 });

    expect(screen.queryByRole('textbox', { name: /note title/i })).not.toBeInTheDocument();
  });

  it('moves the node the pointer dragged', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const disc = discFor(container, 0);
    const circle = disc.querySelector('circle');
    const startX = circle?.getAttribute('cx');

    press(disc, 100, 100);
    fireEvent.pointerMove(disc, { pointerId: 1, clientX: 180, clientY: 100 });

    await waitFor(() => {
      expect(discFor(container, 0).querySelector('circle')?.getAttribute('cx')).not.toBe(startX);
    });
  });

  it('offers a way to put a nudged graph back, and only once there is something to put back', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });
    expect(screen.queryByRole('button', { name: /tidy up/i })).not.toBeInTheDocument();

    const disc = discFor(container, 0);
    const startX = disc.querySelector('circle')?.getAttribute('cx');
    press(disc, 100, 100);
    fireEvent.pointerMove(disc, { pointerId: 1, clientX: 180, clientY: 100 });
    fireEvent.pointerUp(disc, { pointerId: 1, clientX: 180, clientY: 100 });

    const tidy = await screen.findByRole('button', { name: /tidy up/i });
    fireEvent.click(tidy);

    await waitFor(() => {
      expect(discFor(container, 0).querySelector('circle')?.getAttribute('cx')).toBe(startX);
    });
  });

  it('ignores a secondary-button press, which belongs to the browser', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const disc = discFor(container, 0);
    fireEvent.pointerDown(disc, { button: 2, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(disc, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(screen.queryByRole('textbox', { name: /note title/i })).not.toBeInTheDocument();
  });
});

/**
 * Touch, where the mouse tests above do not reach.
 *
 * A hover never happened on a coarse pointer, so the label a mouse reader sees before opening a
 * node never showed up for a touch reader - the first tap here is deliberately not the click tests
 * above exercise. `matchMedia` is overridden per test the same way `tabs-flows.test.tsx` fakes a
 * coarse pointer for its own move-picker regression, rather than through `stubViewport`, whose own
 * comment says it answers every query with one fixed value - not a distinction this suite needs to
 * draw for width.
 */
describe('touching a node on a coarse pointer', () => {
  function discFor(container: HTMLElement, index: number): SVGGElement {
    const groups = [...container.querySelectorAll('svg > g.group')];
    const group = groups[index];
    if (group === undefined) {
      throw new Error(`no node group at ${String(index)}`);
    }
    return group as SVGGElement;
  }

  function press(target: Element, x: number, y: number): void {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: x, clientY: y });
  }

  function tap(target: Element, x: number, y: number): void {
    press(target, x, y);
    fireEvent.pointerUp(target, { pointerId: 1, clientX: x, clientY: y });
  }

  function stubCoarsePointer(): void {
    // Coarse for the pointer query alone; every other query - the desktop-width one this suite's
    // own default answers `true` - keeps answering `true`, so a touch graph is still a wide one.
    globalThis.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: query === '(pointer: coarse)' || !query.includes('pointer'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }

  it('selects the node on the first tap, naming it, without opening it', async () => {
    stubCoarsePointer();
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const disc = discFor(container, 0);
    tap(disc, 100, 100);

    expect(screen.queryByRole('textbox', { name: /note title/i })).not.toBeInTheDocument();

    const label = [...container.querySelectorAll('svg text')].find(
      (text) => text.textContent === 'Specifications',
    );
    expect(label?.getAttribute('class')).not.toContain('opacity-0');
    expect(screen.getByText('Open Specifications')).toBeVisible();
  });

  it('opens on the second tap of the already-selected node', async () => {
    stubCoarsePointer();
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const disc = discFor(container, 0);
    tap(disc, 100, 100);
    tap(disc, 100, 100);

    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue(
      'Specifications',
    );
  });

  it('opens through its own "Open" button as well as a second tap', async () => {
    stubCoarsePointer();
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const disc = discFor(container, 0);
    tap(disc, 100, 100);
    fireEvent.click(screen.getByText('Open Specifications'));

    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue(
      'Specifications',
    );
  });

  it('leaves a mouse opening on the first tap, exactly as before', async () => {
    stubCoreApi({ items: [ROOT, OTHER] });
    const { container } = renderAt(<App />, '/graph');

    await screen.findByRole('tree', { name: /workspace graph/i });

    const disc = discFor(container, 0);
    tap(disc, 100, 100);

    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue(
      'Specifications',
    );
  });
});

describe('where a graph node opens', () => {
  async function clickRoadmap(path = '/graph'): Promise<void> {
    stubCoreApi({ items: [ROOT, OTHER] });
    renderAt(<App />, path);
    await screen.findByRole('tree', { name: /workspace graph/i });
    const roadmap = within(graphTree()).getByRole('treeitem', { name: /Roadmap/i });
    await userEvent.click(within(roadmap).getByRole('button'));
  }

  const pinnedFlag = (): boolean | undefined =>
    useTabStore.getState().byPane[0]?.find((tab) => tab.itemId === OTHER.id)?.pinned;

  it('offers the choice, defaulting to the dialog', async () => {
    stubCoreApi({ items: [OTHER] });
    renderAt(<App />, '/graph');
    await screen.findByRole('tree', { name: /workspace graph/i });
    const control = screen.getByRole('combobox', { name: 'Open items in' });
    expect(control).toHaveValue('dialog');
    expect(
      within(control)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Page', 'Dialog', 'New tab']);
  });

  it('stores the chosen mode in the preference', async () => {
    stubCoreApi({ items: [OTHER] });
    renderAt(<App />, '/graph');
    await screen.findByRole('tree', { name: /workspace graph/i });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Open items in' }), 'tab');
    expect(useGraphOpenPreference.getState().mode).toBe('tab');
  });

  it('navigates to the item as a preview in page mode, with no dialog', async () => {
    useGraphOpenPreference.setState({ mode: 'page' });
    await clickRoadmap();
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('Roadmap');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(pinnedFlag()).toBe(false);
  });

  it('opens the item as a pinned tab in tab mode', async () => {
    useGraphOpenPreference.setState({ mode: 'tab' });
    await clickRoadmap();
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('Roadmap');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(pinnedFlag()).toBe(true);
  });

  it('reads a synced beside as a dialog, since the graph has no pane to open beside', async () => {
    useGraphOpenPreference.getState().setMode('beside');
    expect(useGraphOpenPreference.getState().mode).toBe('dialog');
    await clickRoadmap();
    expect(await screen.findByRole('dialog', { name: 'Roadmap' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Open items in' })).toHaveValue('dialog');
  });

  it('opens a page on a phone whatever the mode', async () => {
    stubViewport(false);
    useGraphOpenPreference.setState({ mode: 'dialog' });
    await clickRoadmap(`/w/00000000-0000-4000-8000-000000000001/graph?focus=${OTHER.id}`);
    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('Roadmap');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
