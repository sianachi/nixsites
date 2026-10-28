import { readTextAlignment, readToggleLevel } from '@nix/editor-schema';
import { ICON_STROKE_WIDTH } from '@nix/ui';

/**
 * How a toggle presents to a keyboard and a screen reader: the disclosure control, and the
 * heading semantics of a toggle heading's summary.
 *
 * The details extension renders each toggle through a node view and hands `renderToggleButton`
 * the button it created, outside React's tree - so this is DOM work by necessity, not choice.
 * It lives in its own file rather than inline in `note-editor.tsx` because it carries behaviour
 * worth testing on its own: a toggle starts closed and its body carries `hidden`, so a button
 * a keyboard cannot reach or operate means content a keyboard-only reader cannot open at all.
 *
 * Two things the vendor default gets wrong for this product. It draws no icon at all, leaving
 * the slot to be filled by a text glyph - which is what the icon rule exists to prevent, and
 * which would not match the Lucide chevrons used everywhere else in the editor. And it names
 * every button "Expand details content" or "Collapse details content", so a document with six
 * toggles announces six identical controls - and each renames itself as it toggles, where the
 * disclosure pattern wants a constant name and `aria-expanded` carrying the state.
 */

/** What the details extension hands its toggle-button renderer. */
interface ToggleButtonArgs {
  readonly element: HTMLButtonElement;
  readonly isOpen: boolean;
  readonly node: { readonly firstChild: { readonly textContent: string | null } | null };
}

/**
 * The disclosure chevron, as an element rather than a React node.
 *
 * The extension hands over a raw DOM element, outside React's tree, so `<Icon>` cannot be
 * used here. The geometry is Lucide's `chevron-right` at the icon component's own stroke
 * width, so it matches every other chevron in the product; taking the path data rather than
 * the component is what that constraint costs.
 */
function chevron(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(ICON_STROKE_WIDTH));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'size-4');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm9 18 6-6-6-6');
  svg.append(path);

  return svg;
}

/**
 * Decorates the toggle button the details extension renders.
 *
 * Called again on every transaction that touches the node - each keystroke in the summary
 * included, not only an open or a close - so everything here is idempotent: attributes are
 * set rather than accumulated, the handler is assigned rather than added, and the icon is
 * built only while the slot is still empty.
 */
export function renderToggleButton({ element, isOpen, node }: ToggleButtonArgs): void {
  // The disclosure pattern: a constant name saying which section this is, with the open
  // state carried by `aria-expanded` alone. A name that flips between "Expand X" and
  // "Collapse X" is a button that renames itself, not a disclosure that reports its state.
  element.setAttribute('aria-expanded', String(isOpen));

  const summary = node.firstChild?.textContent?.trim();
  element.setAttribute(
    'aria-label',
    summary !== undefined && summary.length > 0 ? summary : 'Untitled section',
  );

  // A control inside a contenteditable region is part of the editable content, and browsers
  // do not reliably let Tab reach one. Marking the button as its own non-editable island is
  // what restores focusability - and with it the only route a keyboard has into a closed
  // toggle's body.
  element.setAttribute('contenteditable', 'false');
  element.setAttribute('tabindex', '0');

  // Activation by hand rather than by trusting the browser. A native button fires its click
  // on Enter and Space, but this one sits inside a contenteditable region where ProseMirror
  // also listens for both keys - Enter would split a block, Space would scroll - so the
  // event is claimed here before either can act on it. `preventDefault` also stops the
  // browsers that do activate natively from firing a second click on top of this one, and
  // the `repeat` guard keeps a held key from flickering the section open and shut.
  //
  // Assigned rather than `addEventListener`, because this renderer runs again on every
  // transaction and stacked listeners would open and immediately re-close the section.
  element.onkeydown = (event: KeyboardEvent): void => {
    if ((event.key !== 'Enter' && event.key !== ' ') || event.repeat) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    element.click();

    // The extension's own click handler ends by handing focus to the document - right for a
    // pointer, which is headed back to the text, and wrong for a keyboard, which is stranded
    // mid-interaction: the next Space types a space instead of closing the section, and the
    // state change is announced on an element nobody is on, which is to say to nobody.
    //
    // Taken back twice, because TipTap's `focus()` command steals it twice. On Safari and on
    // mobile it calls `view.dom.focus()` synchronously inside the click dispatch above, which
    // the first line answers. Everywhere else the steal is inside a `requestAnimationFrame`
    // scheduled during that dispatch, so a synchronous restore alone would be undone a frame
    // later - and the callbacks run in registration order, which is what makes this one,
    // scheduled after the click returns, the last word.
    element.focus();
    requestAnimationFrame(() => {
      element.focus();
    });
  };

  // Built once, not rebuilt. `replaceChildren(chevron())` was idempotent by construction and
  // would be the safer shape, but this renderer runs on every transaction that touches the
  // node - every keystroke in the summary - and that version discarded and re-created an SVG
  // each time. The guard trades that for an assumption: nothing but this function puts
  // children on the button, which holds because the button is the extension's and its only
  // other writer is the vendor default this replaces.
  if (element.firstElementChild === null) {
    element.append(chevron());
  }
}

/** The slice of a node view's arguments the summary renderer reads. */
interface ToggleSummaryViewArgs {
  readonly node: { readonly attrs: Record<string, unknown> };
  readonly editor: {
    readonly state: {
      readonly doc: {
        resolve: (pos: number) => {
          readonly parent: { readonly attrs: Record<string, unknown> };
        };
      };
    };
  };
  readonly getPos: () => number | undefined;
}

/** What the summary's node view hands back to ProseMirror. */
interface ToggleSummaryView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  readonly update: (node: {
    readonly type: { readonly name: string };
    readonly attrs: Record<string, unknown>;
  }) => boolean;
}

/**
 * The summary's node view: a `<summary>` that is honestly a heading when its toggle is one.
 *
 * A toggle heading renders its summary at the matching heading's type step (`prose.ts`), but
 * a type step is invisible to a screen reader: without a role, the document shows a hierarchy
 * assistive technology cannot hear or navigate. The level lives on the *parent* details node,
 * which the summary's own `renderHTML` cannot see - a node view can reach it through the
 * document, which is why this exists at all. A plain toggle's summary stays plain: bolded
 * text is not a heading.
 *
 * The level is read at construction and not re-checked on updates, because nothing changes a
 * toggle's level after creation today - the slash menu sets it in the same transaction that
 * builds the node. A control that re-levels an existing toggle must revisit this.
 */
export function toggleSummaryView({
  editor,
  getPos,
  node,
}: ToggleSummaryViewArgs): ToggleSummaryView {
  const dom = document.createElement('summary');
  dom.style.textAlign = readTextAlignment(node.attrs.textAlign) ?? '';

  const pos = getPos();
  const level =
    pos === undefined
      ? null
      : readToggleLevel(editor.state.doc.resolve(pos).parent.attrs.toggleLevel);
  if (level !== null) {
    dom.setAttribute('role', 'heading');
    dom.setAttribute('aria-level', String(level));
  }

  return {
    dom,
    contentDOM: dom,
    update: (updated) => {
      if (updated.type.name !== 'detailsSummary') return false;
      dom.style.textAlign = readTextAlignment(updated.attrs.textAlign) ?? '';
      return true;
    },
  };
}
