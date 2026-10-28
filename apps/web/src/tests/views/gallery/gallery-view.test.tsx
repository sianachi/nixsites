import type * as apiClient from '@nix/api-client';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '../../render-with-router';
import { aView, itemOf, schemaOf } from '../../view-fixture';
import { aContainer, views } from '../../container-fixture';
import { fileImageReference } from '../../../properties/inputs/image-reference';
import type {
  EffectiveSchema,
  Item,
  PropertyDefinition,
  View,
} from '../../../views/core/container-model';
import { GalleryView } from '../../../views/gallery/gallery-view';
import type { ContainerData } from '../../../views/core/use-container';

const WORKSPACE = 'a1000000-0000-4000-8000-000000000001';

// The gallery reaches the workspace and the client for exactly one thing - uploading a cover -
// which none of the read-only tests above exercise. They still render through these mocks rather
// than the real hooks, because the real ones throw outside their providers, and this suite renders
// `GalleryView` as a bare leaf the way `drive-view.test.tsx` does for the same reason.
vi.mock('../../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
  useOptionalWorkspace: () => ({ workspaceId: WORKSPACE }),
}));

const { beginUploadMock, uploadAndCompleteFileMock } = vi.hoisted(() => ({
  beginUploadMock: vi.fn((input: unknown) => ({ operation: 'files.upload.begin', body: input })),
  uploadAndCompleteFileMock: vi.fn(() =>
    Promise.resolve({ itemId: 'uploaded-file-item', workspaceId: WORKSPACE }),
  ),
}));

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => ({ execute: vi.fn(() => Promise.resolve({ id: 'upload-1' })) }),
  // The card menu's reminder entry asks for an optional client; none here leaves it out.
  useOptionalApiClient: () => null,
}));

vi.mock('@nix/api-client', async () => {
  const actual = await vi.importActual<typeof apiClient>('@nix/api-client');
  return {
    ...actual,
    files: {
      ...actual.files,
      beginUpload: beginUploadMock,
      uploadAndCompleteFile: uploadAndCompleteFileMock,
    },
  };
});

beforeEach(() => {
  beginUploadMock.mockClear();
  uploadAndCompleteFileMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The gallery, and above all what it says when a cover is not there.
 *
 * Every assertion here is a variation on one rule: **the items are the view, and the cover is
 * decoration on it.** Four different things can be wrong with a cover and none of them is allowed
 * to remove an item from the screen or to be described as one of the other three. The states are
 * near-identical on screen and completely different to the person reading them - "there is no
 * picture in this field" and "the picture in this field will not load" send somebody to two
 * different places - which is exactly the kind of distinction a build quietly collapses.
 */

const COVER: PropertyDefinition = {
  key: 'cover',
  label: 'Cover',
  type: 'image',
  options: [],
  required: false,
};

const OWNER: PropertyDefinition = {
  key: 'owner',
  label: 'Owner',
  type: 'text',
  options: [],
  required: false,
};

function viewOf(overrides: Partial<View> = {}): View {
  return aView({
    id: 'v1000000-0000-4000-8000-000000000001',
    name: 'Covers',
    kind: 'gallery',
    coverProperty: 'cover',
    ...overrides,
  });
}

const SHOT = 'https://images.example.test/shot.jpg';
const GONE = 'https://images.example.test/deleted.jpg';

const WITH_COVER = itemOf({
  id: 'i1',
  title: 'Harbour at dawn',
  seq: 1000,
  properties: { cover: SHOT, owner: 'Ada' },
});

const WITH_OTHER_COVER = itemOf({
  id: 'i3',
  title: 'Quay at noon',
  seq: 1500,
  properties: { cover: `${SHOT}?second`, owner: 'Ada' },
});

const WITHOUT_COVER = itemOf({
  id: 'i2',
  title: 'Notes from the site visit',
  seq: 2000,
  properties: { owner: 'Grace' },
});

function galleryOf(options: {
  readonly items: readonly Item[];
  readonly view?: View;
  readonly schema?: EffectiveSchema | null;
  readonly onOpen?: (itemId: string) => void;
  /** Lets a test about writes hand in its own container, spies and all. */
  readonly container?: ContainerData;
}): ReactElement {
  const container: ContainerData =
    options.container ??
    aContainer({
      schema: options.schema === undefined ? schemaOf(COVER, OWNER) : options.schema,
      views: views([]),
      children: [...options.items],
    });

  return (
    <GalleryView
      container={container}
      view={options.view ?? viewOf()}
      onOpen={options.onOpen ?? (() => undefined)}
    />
  );
}

/**
 * The card whose heading is this title. A card is a list item, so the list item is the card.
 *
 * Note the queries below ask for `presentation`, not `img`. A cover carries `alt=""`, which maps to
 * the implicit role `presentation` - so `queryByRole('img')` can never match one, and an assertion
 * written that way passes whether or not a picture is on screen. Three of the "no picture region at
 * all" assertions here were exactly that, and were the only guard on the states they covered.
 */
function card(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  const item = heading.closest('li');

  if (item === null) {
    throw new Error(`"${title}" is not inside a card.`);
  }

  return item;
}

/** The fixed-ratio frame around a card's cover picture, found from the picture inside it. */
function coverFrame(title: string): HTMLElement {
  const image = within(card(title)).getByRole('presentation', { hidden: true });
  const frame = image.closest('[class*="aspect-"]');

  if (!(frame instanceof HTMLElement)) {
    throw new Error(`The cover on "${title}" is not inside a fixed-ratio frame.`);
  }

  return frame;
}

describe('the gallery view', () => {
  it('opens the cover picker from a card context menu', async () => {
    const user = userEvent.setup();
    renderAt(galleryOf({ items: [WITH_COVER] }));
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Harbour at dawn' }), {
      clientX: 10,
      clientY: 10,
    });
    await user.click(screen.getByRole('menuitem', { name: 'Change cover' }));
    expect(screen.getByRole('dialog', { name: /Harbour at dawn/ })).toBeInTheDocument();
  });

  it('keeps a 3,200-card gallery DOM bounded and announces positions in the full set', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1_440);
    const many = Array.from({ length: 3_200 }, (_unused, index) =>
      itemOf({ id: `item-${String(index)}`, title: `Item ${String(index + 1)}`, seq: index }),
    );

    renderAt(galleryOf({ items: many }));

    const rendered = screen.getAllByRole('listitem');
    expect(rendered.length).toBeLessThanOrEqual(100);
    expect(rendered[0]).toHaveAttribute('aria-posinset', '1');
    expect(rendered[0]).toHaveAttribute('aria-setsize', '3200');
  });

  it('reflows to one column at the base width, widening only as the breakpoints allow', () => {
    renderAt(galleryOf({ items: [WITH_COVER, WITHOUT_COVER] }));

    // Class contract, jsdom measuring nothing: the grid is mobile-first - one column with no
    // breakpoint qualifier, so a 375px viewport gets a single stack - and every wider count is
    // gated behind a breakpoint. Asserted so the mobile claim is verified rather than assumed;
    // the rendered reflow itself belongs to a real-browser pass.
    expect(screen.getByRole('list', { name: 'Covers' })).toHaveClass(
      'grid-cols-1',
      '@2xl/gallery:grid-cols-2',
      '@5xl/gallery:grid-cols-3',
      '@7xl/gallery:grid-cols-4',
    );
  });

  it('keeps a retained card draft and focus as the virtual range and pane width change', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1_440);
    let viewportHeight = 900;
    vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => viewportHeight);
    let scrollPosition = 0;
    let width = 320;
    const rowGap = 10.2;
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = computedStyle(element, pseudo);
      Object.defineProperty(style, 'rowGap', { value: `${String(rowGap)}px`, configurable: true });
      return style;
    });
    const observers: { readonly element: Element; readonly resize: () => void }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly resize: () => void) {}
        observe(element: Element): void {
          observers.push({ element, resize: this.resize });
        }
        unobserve(): void {
          return undefined;
        }
        disconnect(): void {
          observers.splice(
            0,
            observers.length,
            ...observers.filter((entry) => entry.resize !== this.resize),
          );
        }
      },
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const row = this.dataset.virtualIndex;
      const top = -scrollPosition + (row === undefined ? 0 : Number(row) * (300 + rowGap));
      const height = row === undefined ? 900 : 300;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
      };
    });
    const many = Array.from({ length: 200 }, (_unused, index) =>
      itemOf({
        id: `item-${String(index)}`,
        title: `Item ${String(index + 1)}`,
        seq: index,
        properties: { owner: 'Saved owner' },
      }),
    );
    const write = vi.fn(() => Promise.resolve(null));
    renderAt(
      galleryOf({
        items: many,
        view: viewOf({ columns: ['owner'], coverProperty: null }),
        container: aContainer({ schema: schemaOf(OWNER), children: many, setProperties: write }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Item 2' }).closest('li')).toHaveAttribute(
        'data-virtual-index',
        '1',
      );
    });
    await user.click(within(card('Item 2')).getByRole('button', { name: /Owner for Item 2/ }));
    const field = within(screen.getByRole('dialog', { name: 'Owner for Item 2' })).getByRole(
      'textbox',
      { name: 'Owner for Item 2' },
    );
    field.focus();
    fireEvent.change(field, { target: { value: 'Draft owner' } });
    const initialCards = screen.getAllByRole('listitem').length;
    viewportHeight = 1_400;
    fireEvent(window, new Event('resize'));
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).not.toHaveLength(initialCards);
    });
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Draft owner');
    width = 1_024;
    act(() => {
      for (const observer of observers.filter(
        (entry) => entry.element === screen.getByRole('list', { name: 'Covers' }),
      ))
        observer.resize();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Item 2' }).closest('li')).toHaveAttribute(
        'data-virtual-index',
        '0',
      );
    });
    expect(within(card('Item 2')).getByRole('textbox', { name: 'Owner for Item 2' })).toBe(field);
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Draft owner');
    scrollPosition = 15_000;
    fireEvent.scroll(window);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Item 150' })).toBeInTheDocument();
    });
    expect(within(card('Item 2')).getByRole('textbox', { name: 'Owner for Item 2' })).toBe(field);
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Draft owner');
    expect(screen.getAllByRole('listitem').length).toBeLessThan(100);
    expect(
      screen.getByRole('list', { name: 'Covers' }).querySelector('li[aria-hidden="true"]'),
    ).toBeInTheDocument();
    width = 320;
    act(() => {
      for (const observer of observers.filter(
        (entry) => entry.element === screen.getByRole('list', { name: 'Covers' }),
      ))
        observer.resize();
    });
    await waitFor(() => {
      expect(field.closest('li')).toHaveAttribute('data-virtual-index', '1');
    });
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Draft owner');
    expect(write).not.toHaveBeenCalled();
  });

  it('draws medium cards when the view names no size', () => {
    renderAt(galleryOf({ items: [WITH_COVER], view: viewOf({ cardSize: null }) }));

    expect(screen.getByRole('list', { name: 'Covers' })).toHaveClass(
      'grid-cols-1',
      '@2xl/gallery:grid-cols-2',
      '@5xl/gallery:grid-cols-3',
      '@7xl/gallery:grid-cols-4',
    );
    expect(coverFrame('Harbour at dawn')).toHaveClass('aspect-video');
  });

  it('packs small cards denser and squares their covers', () => {
    renderAt(galleryOf({ items: [WITH_COVER], view: viewOf({ cardSize: 'small' }) }));

    expect(screen.getByRole('list', { name: 'Covers' })).toHaveClass(
      'grid-cols-1',
      '@2xl/gallery:grid-cols-3',
      '@5xl/gallery:grid-cols-4',
      '@7xl/gallery:grid-cols-6',
    );

    // The aspect is part of the size, not left to the grid: a sixth of a row at 16:9 is a
    // letterbox sliver nobody can read a picture in.
    expect(coverFrame('Harbour at dawn')).toHaveClass('aspect-square');
  });

  it('gives large cards fewer columns and a deeper cover', () => {
    renderAt(galleryOf({ items: [WITH_COVER], view: viewOf({ cardSize: 'large' }) }));

    expect(screen.getByRole('list', { name: 'Covers' })).toHaveClass(
      'grid-cols-1',
      '@5xl/gallery:grid-cols-2',
      '@7xl/gallery:grid-cols-3',
    );
    expect(coverFrame('Harbour at dawn')).toHaveClass('aspect-4/3');
  });

  it('draws a size this build does not know as medium rather than failing the view', () => {
    // A newer server's token: the size costs itself, never the cards. Falling back to medium keeps
    // every item on screen at the shape galleries have always been.
    renderAt(galleryOf({ items: [WITH_COVER], view: viewOf({ cardSize: 'huge' }) }));

    expect(screen.getByRole('list', { name: 'Covers' })).toHaveClass(
      'grid-cols-1',
      '@7xl/gallery:grid-cols-4',
    );
    expect(coverFrame('Harbour at dawn')).toHaveClass('aspect-video');
  });

  it('sizes the wordy cover states with the same frame as the pictures', () => {
    // The frame's whole contract is that its geometry is identical in every state, so the size has
    // to reach the "No cover" words too - a grid where the pictures are square and the absences
    // are 16:9 reflows as covers resolve, which is the fault the frame exists to prevent.
    renderAt(galleryOf({ items: [WITHOUT_COVER], view: viewOf({ cardSize: 'small' }) }));

    const frame = within(card('Notes from the site visit')).getByText('No cover').parentElement;
    expect(frame).toHaveClass('aspect-square');
  });

  it('draws a card for every item whether or not it has a cover', () => {
    // The headline rule. An item with no picture is an item, and a gallery that showed only the
    // ones it could illustrate would be hiding the container's contents behind a decoration.
    renderAt(galleryOf({ items: [WITH_COVER, WITHOUT_COVER] }));

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Harbour at dawn' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notes from the site visit' })).toBeInTheDocument();

    const illustrated = within(card('Harbour at dawn')).getByRole('presentation', { hidden: true });
    expect(illustrated).toHaveAttribute('src', SHOT);
  });

  it('says a card has no cover rather than drawing an empty frame', () => {
    // An empty box is indistinguishable from a cover that failed to load and from a picture that
    // happens to be white. The words are the only thing that tells the three apart.
    renderAt(galleryOf({ items: [WITHOUT_COVER] }));

    const bare = card('Notes from the site visit');

    expect(within(bare).getByText('No cover')).toBeInTheDocument();
    expect(within(bare).queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('draws no picture region at all when the view asks for no covers', () => {
    // Not "No cover" either: that would be reporting the absence of something nobody asked for. A
    // gallery with no cover property is a grid of titled cards, and the cards are complete.
    renderAt(galleryOf({ items: [WITH_COVER], view: viewOf({ coverProperty: null }) }));

    expect(screen.queryByText('No cover')).not.toBeInTheDocument();
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Harbour at dawn' })).toBeInTheDocument();
  });

  it('says a cover could not be loaded rather than pretending the item has none', () => {
    // The distinction this test exists for. Falling back to "No cover" would claim the field is
    // empty when it holds a perfectly good address that is not resolving, and would send somebody
    // to re-enter a URL that is already right.
    const broken = itemOf({ id: 'i3', title: 'Site plan', properties: { cover: GONE } });

    renderAt(galleryOf({ items: [broken] }));

    fireEvent.error(within(card('Site plan')).getByRole('presentation', { hidden: true }));

    const failed = card('Site plan');

    expect(within(failed).getByText(/This cover could not be loaded/)).toBeInTheDocument();
    expect(within(failed).queryByText('No cover')).not.toBeInTheDocument();

    // The address is on screen, because it is the only thing here anybody can act on.
    expect(within(failed).getByText(GONE)).toBeInTheDocument();
  });

  it('says covers are unavailable when the property they came from is gone, and still shows every item', () => {
    // A schema edit made somewhere else, by somebody who has never seen this gallery. The notice
    // names the property; the grid keeps every card.
    renderAt(
      galleryOf({
        items: [WITH_COVER, WITHOUT_COVER],
        schema: schemaOf(OWNER),
      }),
    );

    const notice = screen.getByRole('status');

    expect(notice).toHaveTextContent('cover');
    expect(notice).toHaveTextContent('Every item is still here');

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Harbour at dawn' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notes from the site visit' })).toBeInTheDocument();

    // Coverless, not broken: nothing failed to load, so nothing may say it did.
    expect(screen.queryByText(/This cover could not be loaded/)).not.toBeInTheDocument();
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('says covers are unavailable when the property they came from is no longer a picture', () => {
    // Retyping a picture to text is one edit in the schema panel. The value is still there and is
    // no longer something to put in an img src, so the gallery names the type it has become.
    renderAt(
      galleryOf({
        items: [WITH_COVER],
        schema: schemaOf({ ...COVER, type: 'text' }, OWNER),
      }),
    );

    const notice = screen.getByRole('status');

    expect(notice).toHaveTextContent('Cover');

    // The label a person was shown when they chose the type, never the stored token. Asserting the
    // token here would bake the jargon in - and the jargon is worse than it looks, because the
    // likeliest retype targets spell themselves "multi_select" and "timestamp".
    expect(notice).toHaveTextContent('Text');
    expect(notice).not.toHaveTextContent('multi_select');

    expect(screen.getByRole('heading', { name: 'Harbour at dawn' })).toBeInTheDocument();
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('keeps a retyped cover property out of the card body rather than listing its address', () => {
    // The value is text now, so listing it as a column would be defensible - and would put a wall
    // of unreadable URLs under the titles, contradicting the notice directly above them. Somebody
    // chose it as the cover, not as a column.
    renderAt(
      galleryOf({
        items: [WITH_COVER],
        view: viewOf({ columns: ['cover', 'owner'] }),
        schema: schemaOf({ ...COVER, type: 'text' }, OWNER),
      }),
    );

    const retyped = card('Harbour at dawn');

    expect(within(retyped).queryByText(SHOT)).not.toBeInTheDocument();
    expect(
      within(retyped).getByRole('button', { name: /Owner for Harbour at dawn/ }),
    ).toHaveTextContent('Ada');
  });

  it('refuses to point a picture at a value that is not a fetchable address', () => {
    // Reachable without the server ever having seen it: retyping a text property to Picture does
    // not revalidate what is already stored. Handed to an img this resolves against the workspace
    // origin and fetches the application shell, so it is caught before it becomes a request.
    const pasted = itemOf({ id: 'i5', title: 'Studio wall', properties: { cover: 'draft notes' } });

    renderAt(galleryOf({ items: [pasted] }));

    const wrong = card('Studio wall');

    expect(within(wrong).getByText('This is not a picture address')).toBeInTheDocument();
    expect(within(wrong).queryByText('No cover')).not.toBeInTheDocument();
    expect(within(wrong).queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('names the property to correct when a cover will not load', () => {
    // The address is the evidence; the property is where the fix is made. Without the name,
    // somebody on a card with four properties has to guess which one held the picture.
    const broken = itemOf({ id: 'i6', title: 'Roof detail', properties: { cover: GONE } });

    renderAt(galleryOf({ items: [broken] }));

    fireEvent.error(within(card('Roof detail')).getByRole('presentation', { hidden: true }));

    expect(within(card('Roof detail')).getByText(/Check the address in Cover/)).toBeInTheDocument();
  });

  it('gives every card a heading, so a grid can be walked without tabbing through it', () => {
    // A gallery is a page of named things and nothing else. A span styled to look like a heading
    // leaves a screen reader user tabbing through every title button to move between cards.
    renderAt(galleryOf({ items: [WITH_COVER, WITHOUT_COVER] }));

    expect(screen.getAllByRole('heading')).toHaveLength(2);
  });

  it('does not send the workspace address to the host serving a cover', () => {
    // A cover URL is arbitrary and third-party - somebody pasted it into a property. Without this,
    // every reader's browser announces the page it came from, which is a workspace address carrying
    // the item id, to a host the workspace does not control. Same argument app.css makes for
    // refusing a font CDN.
    renderAt(galleryOf({ items: [WITH_COVER] }));

    const cover = within(card('Harbour at dawn')).getByRole('presentation', { hidden: true });

    expect(cover).toHaveAttribute('referrerpolicy', 'no-referrer');

    // Alongside it, because a wall of covers decoded and fetched eagerly blocks the scroll of the
    // grid they are in.
    expect(cover).toHaveAttribute('loading', 'lazy');
    expect(cover).toHaveAttribute('decoding', 'async');
  });

  it('draws a cover through the duotone treatment rather than as a bare photograph', () => {
    // The design grammar's answer for any image: a wall of arbitrary third-party photographs is
    // the one thing most able to make a considered interface look like a search result, and the
    // treatment maps them onto two token colours so they read as one surface.
    //
    // Asserted through the filter reference rather than by looking for the element, because a
    // component that merely wrapped the picture and applied nothing would pass that. The id is
    // generated per instance, so this also pins that two covers cannot share one filter.
    renderAt(galleryOf({ items: [WITH_COVER, WITH_OTHER_COVER] }));

    const covers = screen
      .getAllByRole('presentation', { hidden: true })
      .filter((element) => element.tagName === 'IMG');

    expect(covers).toHaveLength(2);

    // Read off the attribute rather than `style.filter`: jsdom does not parse `filter` into the
    // style object, so the property reads empty and an assertion on it would pass against a bare
    // photograph. The library's own tests read it the same way.
    // Quotes optional: the DOM serialises the property back as `url("#id")`, so a pattern written
    // for the unquoted form finds nothing and reports a bare photograph.
    const references = covers.map(
      (cover) => /url\(["']?#([^"')]+)["']?\)/.exec(cover.getAttribute('style') ?? '')?.[1],
    );

    expect(references.filter((reference) => reference !== undefined)).toHaveLength(2);
    expect(new Set(references).size).toBe(2);
  });

  it('names a cover nothing rather than repeating the title beside it', () => {
    // The picture carries nothing the card does not already say as text - the title is directly
    // beneath it. `alt={item.title}` would have a screen reader announce the same words twice.
    renderAt(galleryOf({ items: [WITH_COVER] }));

    expect(
      within(card('Harbour at dawn')).getByRole('presentation', { hidden: true }),
    ).toHaveAttribute('alt', '');
  });

  it('stops reporting a failure once the address changes', () => {
    // The failure belongs to a URL, not to a card. Somebody who corrects a typo must not be told
    // their corrected address failed too - which is what a flag reconciled in an effect, or not
    // reconciled at all, would tell them. Driven through a state change so the gallery meets the
    // new value the way it really does: a property write lands and the item arrives again.
    function Corrected(): ReactNode {
      const [cover, setCover] = useState(GONE);

      return (
        <>
          <button
            type="button"
            onClick={() => {
              setCover(SHOT);
            }}
          >
            Correct the address
          </button>
          {galleryOf({ items: [itemOf({ id: 'i4', title: 'Elevation', properties: { cover } })] })}
        </>
      );
    }

    renderAt(<Corrected />);

    fireEvent.error(within(card('Elevation')).getByRole('presentation', { hidden: true }));
    expect(screen.getByText(/This cover could not be loaded/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Correct the address' }));

    expect(screen.queryByText(/This cover could not be loaded/)).not.toBeInTheDocument();
    expect(within(card('Elevation')).getByRole('presentation', { hidden: true })).toHaveAttribute(
      'src',
      SHOT,
    );
  });

  it('shows the properties the view asked for under a card, and never the cover among them', () => {
    // The cover is the picture; listing its address underneath as a field would be the same value
    // twice, once unreadably.
    renderAt(
      galleryOf({ items: [WITH_COVER], view: viewOf({ columns: ['cover', 'owner', 'title'] }) }),
    );

    const illustrated = card('Harbour at dawn');

    expect(
      within(illustrated).getByRole('button', { name: /Owner for Harbour at dawn/ }),
    ).toHaveTextContent('Ada');
    expect(within(illustrated).queryByText(SHOT)).not.toBeInTheDocument();
  });

  it('opens the item whose card was clicked', () => {
    const opened: string[] = [];

    renderAt(
      galleryOf({
        items: [WITH_COVER, WITHOUT_COVER],
        onOpen: (itemId) => opened.push(itemId),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Notes from the site visit' }));

    expect(opened).toEqual(['i2']);
  });

  it('shows card values as buttons, not form controls', () => {
    const blank = itemOf({ id: 'i9', title: 'Blank card' });
    renderAt(galleryOf({ items: [WITH_COVER, blank], view: viewOf({ columns: ['owner'] }) }));

    expect(within(card('Harbour at dawn')).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(card('Harbour at dawn')).queryByRole('combobox')).not.toBeInTheDocument();
    const empty = within(card('Blank card')).getByRole('button', { name: /Owner for Blank card/ });
    expect(within(empty).getByText('Owner')).toBeInTheDocument();
  });

  it('edits one value in a popover through setProperties, without opening the item', async () => {
    const user = userEvent.setup();
    const setProperties = vi.fn(() => Promise.resolve(null));
    const onOpen = vi.fn();
    const container = aContainer({
      schema: schemaOf(COVER, OWNER),
      views: views([]),
      children: [WITH_COVER],
      setProperties,
    });
    renderAt(
      galleryOf({ items: [WITH_COVER], view: viewOf({ columns: ['owner'] }), container, onOpen }),
    );

    await user.click(screen.getByRole('button', { name: /Owner for Harbour at dawn/ }));
    const field = within(
      screen.getByRole('dialog', { name: /Owner for Harbour at dawn/ }),
    ).getByRole('textbox', { name: /Owner for Harbour at dawn/ });
    await user.clear(field);
    await user.type(field, 'Bo');
    await user.tab();

    await waitFor(() => {
      expect(setProperties).toHaveBeenCalledTimes(1);
    });
    expect(setProperties).toHaveBeenCalledWith('i1', { owner: 'Bo' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('closes the editor on Escape and returns focus to the value', async () => {
    const user = userEvent.setup();
    renderAt(galleryOf({ items: [WITH_COVER], view: viewOf({ columns: ['owner'] }) }));

    const value = screen.getByRole('button', { name: /Owner for Harbour at dawn/ });
    await user.click(value);
    expect(screen.getByRole('dialog', { name: /Owner for Harbour at dawn/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(value).toHaveFocus();
    });
  });

  it('does not start the card long-press from inside an open editor', async () => {
    const user = userEvent.setup();
    renderAt(galleryOf({ items: [WITH_COVER], view: viewOf({ columns: ['owner'] }) }));
    await user.click(screen.getByRole('button', { name: /Owner for Harbour at dawn/ }));
    const inside = screen
      .getByRole('dialog', { name: /Owner for Harbour at dawn/ })
      .querySelector('[data-context-menu-ignore]');
    if (inside === null) throw new Error('The editor is not marked as outside the card gestures.');

    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(inside, { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the container is empty rather than drawing an empty grid', () => {
    renderAt(galleryOf({ items: [] }));

    expect(screen.getByText('Nothing in here yet')).toBeInTheDocument();
  });
});

/**
 * "I should be able to click on them and give them cover images" - the corner control every card
 * carries, and the dialog it opens.
 *
 * The control's own visibility is asserted directly rather than through a hover simulation:
 * Testing Library has no notion of `:hover`, so a control that only *appeared* to be always-on
 * because nothing ever hid it would still pass a `getByRole` query. What actually proves it is
 * always on screen is that `gallery-view.tsx` never applies an opacity or visibility class to it
 * at all - there is nothing here to toggle.
 */
describe('setting a cover from a card', () => {
  function containerFor(options: {
    readonly schema: EffectiveSchema | null;
    readonly view: View;
    readonly items: readonly Item[];
    readonly setProperties?: ContainerData['setProperties'];
    readonly setSchema?: ContainerData['setSchema'];
    readonly setViews?: ContainerData['setViews'];
  }): ContainerData {
    return aContainer({
      schema: options.schema,
      views: views([options.view]),
      children: [...options.items],
      setProperties: options.setProperties ?? (() => Promise.resolve(null)),
      setSchema: options.setSchema ?? (() => Promise.resolve(null)),
      setViews: options.setViews ?? (() => Promise.resolve(null)),
    });
  }

  it('offers every card a visible control, worded by whether it already has a cover', () => {
    renderAt(galleryOf({ items: [WITH_COVER, WITHOUT_COVER] }));

    expect(
      within(card('Harbour at dawn')).getByRole('button', {
        name: 'Change cover for Harbour at dawn',
      }),
    ).toBeInTheDocument();
    expect(
      within(card('Notes from the site visit')).getByRole('button', {
        name: 'Set cover for Notes from the site visit',
      }),
    ).toBeInTheDocument();
  });

  it('opens a dialog naming the card the control belongs to', async () => {
    const user = userEvent.setup();
    renderAt(galleryOf({ items: [WITHOUT_COVER] }));

    await user.click(
      screen.getByRole('button', { name: 'Set cover for Notes from the site visit' }),
    );

    expect(
      screen.getByRole('dialog', { name: 'Cover for "Notes from the site visit"' }),
    ).toBeInTheDocument();
  });

  it('writes a pasted address into the existing cover property', async () => {
    const user = userEvent.setup();
    const setProperties = vi.fn(() => Promise.resolve(null));
    const container = containerFor({
      schema: schemaOf(COVER, OWNER),
      view: viewOf(),
      items: [WITHOUT_COVER],
      setProperties,
    });

    renderAt(galleryOf({ items: [WITHOUT_COVER], container }));

    await user.click(
      screen.getByRole('button', { name: 'Set cover for Notes from the site visit' }),
    );
    await user.click(screen.getByRole('button', { name: 'Image URL' }));
    await user.type(screen.getByRole('textbox', { name: 'Image address' }), SHOT);
    await user.click(screen.getByRole('button', { name: 'Set cover' }));

    await waitFor(() => {
      expect(setProperties).toHaveBeenCalledWith('i2', { cover: SHOT });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('makes a cover property and points the view at it, the first time a card sets one', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));
    const setViews = vi.fn(() => Promise.resolve(null));
    const setProperties = vi.fn(() => Promise.resolve(null));
    const bareView = viewOf({ coverProperty: null });
    const container = containerFor({
      schema: schemaOf(OWNER),
      view: bareView,
      items: [WITHOUT_COVER],
      setSchema,
      setViews,
      setProperties,
    });

    renderAt(galleryOf({ items: [WITHOUT_COVER], view: bareView, container }));

    await user.click(
      screen.getByRole('button', { name: 'Set cover for Notes from the site visit' }),
    );
    await user.click(screen.getByRole('button', { name: 'Image URL' }));
    await user.type(screen.getByRole('textbox', { name: 'Image address' }), SHOT);
    await user.click(screen.getByRole('button', { name: 'Set cover' }));

    await waitFor(() => {
      expect(setProperties).toHaveBeenCalledWith('i2', { cover: SHOT });
    });

    // The schema keeps every property already declared - this is one more property, not a
    // replacement of the whole set - and the view is updated only after the property exists.
    expect(setSchema).toHaveBeenCalledWith({
      properties: [
        OWNER,
        { key: 'cover', label: 'Cover', type: 'image', options: [], required: false },
      ],
      inherit: true,
    });
    expect(setViews).toHaveBeenCalledWith([{ ...bareView, coverProperty: 'cover' }]);
  });

  it('uploads a chosen file through the same path the editor uses, and stores its reference', async () => {
    const user = userEvent.setup();
    const setProperties = vi.fn(() => Promise.resolve(null));
    const container = containerFor({
      schema: schemaOf(COVER, OWNER),
      view: viewOf(),
      items: [WITHOUT_COVER],
      setProperties,
    });

    renderAt(galleryOf({ items: [WITHOUT_COVER], container }));

    await user.click(
      screen.getByRole('button', { name: 'Set cover for Notes from the site visit' }),
    );
    const file = new File(['image'], 'cover.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Image file'), file);

    await waitFor(() => {
      expect(uploadAndCompleteFileMock).toHaveBeenCalled();
    });
    expect(setProperties).toHaveBeenCalledWith('i2', {
      cover: fileImageReference('uploaded-file-item'),
    });
  });

  it('takes an existing cover off by writing null', async () => {
    const user = userEvent.setup();
    const setProperties = vi.fn(() => Promise.resolve(null));
    const container = containerFor({
      schema: schemaOf(COVER, OWNER),
      view: viewOf(),
      items: [WITH_COVER],
      setProperties,
    });

    renderAt(galleryOf({ items: [WITH_COVER], container }));

    await user.click(screen.getByRole('button', { name: 'Change cover for Harbour at dawn' }));
    await user.click(screen.getByRole('button', { name: 'Remove cover' }));

    await waitFor(() => {
      expect(setProperties).toHaveBeenCalledWith('i1', { cover: null });
    });
  });
});
