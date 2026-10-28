import { files as fileResources } from '@nix/api-client';
import { useState, type ReactNode } from 'react';

import { useApiClient } from '../../api/api-client-provider';
import { PartialNotice } from '../../components/states/status-panels';
import { mediaTypeForFile } from '../../lib/file-kind';
import { fileImageReference } from '../../properties/inputs/image-reference';
import { useWorkspace } from '../../workspaces/workspace-context';
import { readPropertyText } from '../core/container-model';
import { ShownItems } from '../core/item-selection-context';
import { CreateItemControl } from '../core/create-item-control';
import type { ViewRendererProps } from '../core/view-kinds';
import { drawable, useViewChrome } from '../core/view-chrome';
import { useViewState } from '../core/view-state';
import { resolveCardSize } from './card-size';
import { CoverPickerDialog } from './cover-picker-dialog';
import { describeLostCover, resolveCover } from './gallery-cover';
import { GalleryGrid } from './gallery-grid';

/**
 * The gallery: a container's children as a grid of cards, each optionally showing a cover picture.
 *
 * **The cover is not a requirement, and that is the decision this whole file is shaped around.** A
 * board with no grouping property has no columns, so it says so instead of drawing; a calendar with
 * no date property has nowhere to put anything. A gallery with no cover property is a grid of
 * titled cards - readable, useful, and what most galleries are on the day somebody makes one. So
 * this view is never undrawable: every path below ends in every item being on screen, and the four
 * things that can be wrong with a cover are said *on* or *above* the cards rather than instead of
 * them.
 *
 * **Four cases, four different sentences**, because collapsing any two of them tells somebody
 * something untrue:
 *
 *   - The view names no cover property. Cards are titles and properties, and there is no picture
 *     region at all. Not a grey box: a placeholder is a claim that something is loading.
 *   - A cover is configured and this item has no value. The frame says "No cover" in words. Not an
 *     empty box, which is indistinguishable from a failed load and from a white picture.
 *   - A cover is configured, the item has one, and it will not load. The frame says so, names the
 *     property to correct, and keeps the address readable. It must not fall back to the case above,
 *     which would claim the item has no cover when what it has is a broken one - and would send
 *     somebody to re-enter a URL that is already correct.
 *   - The cover property was deleted or retyped. Every card draws coverless and a notice above the
 *     grid names the property. The items are the container's; the property was somebody else's
 *     edit, and losing sight of the items over it would be the worst answer available.
 *
 * **A file item's thumbnail is one more source for the picture region, and the lowest.** Where a
 * card would otherwise have no cover - none configured, the property lost, or no value on this
 * item - a file card draws its own thumbnail (the worker's JPEG for images, cover art and EPUBs),
 * or a glyph for its kind where it has none, in the same fixed frame. A configured cover with a
 * value is never displaced, broken or not. The gallery holds no file records, so the thumbnail is
 * asked for lazily, only for cards that are on screen and only for file items whose name says they
 * could have one; a miss is an answer and not an error. Non-file items make no request.
 * PDFs are not drawn here: their first page is rendered in the browser from the whole file, and
 * without a byte length the gallery cannot tell a page from a book.
 *
 * **Two more that the four-way telling misses, and both draw an empty box if you let them:**
 *
 *   - *Still loading.* Every cover below the fold is in this state on first paint, because they are
 *     lazy. An unframed `img` with nothing in it yet is precisely the empty box the second case
 *     forbids, so the picture region is **always** a drawn frame and the picture fills it - the
 *     geometry is identical in all states and never changes as covers resolve.
 *   - *A value that is not a fetchable address.* Retyping a text property to Picture does not
 *     revalidate what is already stored, so `cover: "draft notes"` is reachable without the server
 *     ever having seen it. Handed to an `img` it resolves against this origin, fetches the
 *     application shell, and reports as a failed load - a request fired at our own server, per
 *     card, for something nobody attempted to load. It gets its own sentence instead.
 */

export function GalleryView(props: ViewRendererProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();
  const client = useApiClient();
  const { workspaceId } = useWorkspace();

  const cover = resolveCover(container, view);
  const size = resolveCardSize(view.cardSize);

  // Which card's "Set cover" dialog is open, if any - one dialog shared by every card rather than
  // one per card, since a gallery can hold hundreds of them and only one is ever in front of
  // somebody at a time.
  const [coverItemId, setCoverItemId] = useState<string | null>(null);

  /**
   * The property this gallery's covers write to, making one if none exists yet.
   *
   * **The whole point of the corner button on an unconfigured gallery.** Before this, a cover
   * property had to be declared through the schema editor and then chosen in the view's own
   * settings before a single picture could go anywhere - two dialogs before the one that matters.
   * The first card somebody sets a cover from does both in one step, the same way choosing a date
   * property on an empty board makes the board's grouping property if none is declared.
   *
   * Returns the property's key, or the reason either write was refused - honestly: a property
   * that was declared but never made it into `coverProperty` is not a silent partial success, it
   * is a refusal that still names what broke.
   */
  async function ensureCoverProperty(): Promise<
    { readonly key: string } | { readonly error: string }
  > {
    if (cover.kind === 'ready') return { key: cover.property.key };

    const declared = container.schema?.declared ?? [];
    const used = new Set(declared.map((property) => property.key));
    let key = 'cover';
    for (let suffix = 2; used.has(key); suffix += 1) key = `cover_${String(suffix)}`;

    const schemaRefusal = await container.setSchema({
      properties: [
        ...declared,
        { key, label: 'Cover', type: 'image', options: [], required: false },
      ],
      inherit: container.schema?.inherit ?? true,
    });
    if (schemaRefusal !== null) return { error: schemaRefusal };

    const nextViews = (container.views?.views ?? []).map((candidate) =>
      candidate.id === view.id ? { ...candidate, coverProperty: key } : candidate,
    );
    const viewsRefusal = await container.setViews(nextViews);
    if (viewsRefusal !== null) return { error: viewsRefusal };

    return { key };
  }

  async function uploadCoverFile(itemId: string, file: File): Promise<void> {
    const ensured = await ensureCoverProperty();
    if ('error' in ensured) throw new Error(ensured.error);

    const upload = await client.execute(
      fileResources.beginUpload({
        workspaceId,
        parentId: itemId,
        fileName: file.name,
        mediaType: mediaTypeForFile(file),
        byteLength: file.size,
        idempotencyKey: `web-gallery-cover:${crypto.randomUUID()}`,
      }),
    );
    const uploaded = await fileResources.uploadAndCompleteFile(client, upload, file);
    const refusal = await container.setProperties(itemId, {
      [ensured.key]: fileImageReference(uploaded.itemId),
    });
    if (refusal !== null) throw new Error(refusal);
  }

  async function setCoverAddress(itemId: string, address: string): Promise<void> {
    const ensured = await ensureCoverProperty();
    if ('error' in ensured) throw new Error(ensured.error);

    const refusal = await container.setProperties(itemId, { [ensured.key]: address });
    if (refusal !== null) throw new Error(refusal);
  }

  async function removeCover(itemId: string): Promise<void> {
    // Nothing to clear when there was never a cover property to clear it from.
    if (cover.kind !== 'ready') return;

    const refusal = await container.setProperties(itemId, { [cover.property.key]: null });
    if (refusal !== null) throw new Error(refusal);
  }

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this gallery',
    // Always drawable, and this is the one line that says so. A gallery has cards whatever the
    // schema is doing; see the header. Note that Core never reports a gallery in `unrenderable`
    // either - the kind carries no requirement server-side - so there is no verdict to reconcile
    // with, unlike the board.
    drawable: drawable(cover),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear here as cards.',
    emptyAction: <CreateItemControl label="Add the first item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      detail: `This holds ${countOf(total, 'item')}. The filters in the address are hiding ${total === 1 ? 'it' : 'all of them'}, so the gallery is empty by request rather than because there is nothing here.`,
    }),
    savedRules: view.filters,
    view,
    sortBy: viewState.sortBy ?? view.sortBy,
    descending:
      viewState.sortBy === null ? view.sortDescending : viewState.direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  const resolved = chrome.drawable;

  // The same rule the board's card faces use: the view's `columns` are the properties worth showing
  // under a title. The cover is not one of them - it is the picture - and neither is the title,
  // which the card already leads with.
  //
  // Read off the *view* rather than off the resolved cover, so a property that has been retyped
  // away from a picture stays excluded. It is text now, so listing it would be defensible and
  // would put a wall of raw URLs under the titles - directly against what the notice above the
  // grid is saying, which is that nothing has been lost. Somebody chose it as the cover, not as a
  // column, and undoing that choice for them is not this view's decision to make.
  const secondary = view.columns.filter((key) => key !== view.coverProperty && key !== 'title');
  const schema = container.schema?.properties ?? [];
  const coverItem =
    coverItemId === null ? null : (chrome.items.find((item) => item.id === coverItemId) ?? null);

  return (
    <div className="@container/gallery flex min-h-0 min-w-0 flex-col gap-3">
      <ShownItems ids={chrome.items.map((item) => item.id)} />
      {chrome.notice}

      {/* Above the grid rather than repeated on every card. The property is gone once, not once per
          item, and a notice on forty cards would say one fact forty times. */}
      {resolved.kind === 'missing' || resolved.kind === 'wrongType' ? (
        <PartialNotice pending={describeLostCover(resolved)} />
      ) : null}

      {/* `role="list"` is not redundant. Tailwind's preflight sets `list-style: none` on every
          `ul`, and WebKit drops the list and listitem roles when it sees that - so on Safari with
          VoiceOver this grid would stop announcing "list, 24 items" and become an undifferentiated
          run of controls. That announcement is the whole of what this view promises: every item is
          still here. jsdom does not reproduce the stripping, so the tests below cannot catch it and
          this attribute is what keeps the promise on the platform where it breaks.

          Named after the view, so a switcher tab and the region it opens agree on what they are. */}
      <GalleryGrid
        items={chrome.items}
        label={view.name}
        cover={resolved}
        size={size}
        secondary={secondary}
        schema={schema}
        onOpen={onOpen}
        onWrite={(itemId, propertyKey, value) =>
          container.setProperties(itemId, { [propertyKey]: value })
        }
        onRequestCover={(itemId) => {
          setCoverItemId(itemId);
        }}
      />

      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        className="mt-1 self-start"
      />

      {coverItem === null ? null : (
        <CoverPickerDialog
          itemTitle={coverItem.title}
          hasCover={
            cover.kind === 'ready' && readPropertyText(coverItem, cover.property.key).length > 0
          }
          canUpload
          onClose={() => {
            setCoverItemId(null);
          }}
          onUpload={(file) => uploadCoverFile(coverItem.id, file)}
          onSetAddress={(address) => setCoverAddress(coverItem.id, address)}
          onRemove={() => removeCover(coverItem.id)}
        />
      )}
    </div>
  );
}

/** "1 item", "4 items" - said once here because three views had three spellings of it. */
function countOf(total: number, noun: string): string {
  return `${String(total)} ${total === 1 ? noun : `${noun}s`}`;
}
