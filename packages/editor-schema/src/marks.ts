import { Mark, mergeAttributes, type Command } from '@tiptap/core';

/**
 * The colours text may be given.
 *
 * **Names, never values.** A picker that wrote a literal colour into a document body would
 * hard-code it in the most durable place this product has: a stored document outlives every
 * stylesheet, so the value would be fixed forever, wrong on one of the two grounds from the
 * day it was typed and unfixable without a content migration. A name resolves through the
 * design tokens at render, which is what makes the same document legible on both.
 *
 * **Three, not six.** The token sheet is deliberately mono - one steel accent, no red and no
 * amber (ADR-0011) - so semantic names like `success` and `danger` have no hue to resolve to.
 * Offering them would mean a picker with six entries and three renderings, which is a control
 * that lies: the document would store a distinction the product never honours, permanently, in
 * the place that is hardest to take back. Callouts get away with four tones because a
 * container can vary its border weight; an inline span has no border to vary. Widening this
 * set is an ADR adding a semantic ramp to the tokens, not a class string.
 *
 * A closed set for the same reason `CALLOUT_TONES` is closed, and with the same fallback: a
 * value this build does not know renders as `default` rather than failing to parse. Text in
 * the wrong colour is readable; a document that will not open is not.
 *
 * **The fallback is applied at render, not at parse.** A document arriving from a newer build
 * with a colour this one has never heard of keeps that value in the CRDT and passes it on
 * untouched; only the drawing falls back. Normalising on the way in would mean an older client
 * silently rewriting a newer client's document every time it opened one.
 */
export const TEXT_COLORS = ['default', 'accent', 'muted'] as const;

export type TextColor = (typeof TEXT_COLORS)[number];

const DEFAULT_COLOR: TextColor = 'default';

function readColor(value: unknown): TextColor | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return TEXT_COLORS.includes(value as TextColor) ? (value as TextColor) : DEFAULT_COLOR;
}

/**
 * The two things a colour can be: the ink, or the wash behind it.
 *
 * Named because the two commands below are one piece of behaviour applied to two attributes,
 * and a pair of hand-written near-copies is exactly how the two halves of a symmetry drift
 * apart - one of them learning about the other's clearing rule and the other not.
 */
type ColorAxis = 'text' | 'background';

/** The axis whose survival decides whether clearing this one leaves a mark behind. */
const OTHER_AXIS: Readonly<Record<ColorAxis, ColorAxis>> = {
  text: 'background',
  background: 'text',
};

/**
 * Whether an axis carries nothing.
 *
 * The raw stored value, deliberately not `readColor`: normalising here would count a newer
 * build's unknown colour as `default` and destroy it along with the mark - exactly the silent
 * rewrite the fallback-at-render rule above exists to prevent. A stored `'default'` is the one
 * value that genuinely means "none", so it alone joins the absent cases.
 */
function axisAbsent(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === DEFAULT_COLOR;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textColor: {
      /**
       * Colours the selected text with a token name from `TEXT_COLORS`.
       *
       * `default` clears rather than sets: the token sheet's own foreground is what unmarked
       * text already renders in, so storing `text: 'default'` would pin today's meaning of
       * "ordinary text" into the document. Clearing keeps the mark only while it still says
       * something - a background - and removes it outright otherwise, so toggling a colour on
       * and off leaves the document exactly as it was.
       */
      setTextColor: (color: TextColor) => ReturnType;

      /**
       * Washes the selected text with a token name from `TEXT_COLORS`, behind the ink.
       *
       * The same closed palette and the same clearing rule as `setTextColor`, mirrored: a
       * `default` highlight clears the background and keeps the mark only while a foreground
       * survives on it. Neither command can orphan the other's attribute, and neither can
       * leave a mark behind that says nothing.
       *
       * Not `setHighlight`, which the vendor's `Highlight` extension already owns in this same
       * command namespace, and not `setBackgroundColor`, because the attribute it writes is
       * `background` and a command that cannot be traced to its attribute by name is a command
       * somebody will one day wire to the wrong one.
       */
      setTextBackground: (color: TextColor) => ReturnType;
    };
  }
}

/**
 * Colour, foreground and background together in one mark.
 *
 * One mark rather than two because they are set from one control and are almost always set
 * together; two marks would mean two entries in the schema, two fixtures, and a document
 * where removing the foreground silently leaves an orphan background behind.
 *
 * Deliberately **not** `@tiptap/extension-text-style` with its `Color` and
 * `BackgroundColor`: those store an arbitrary CSS colour in a `style` attribute, which is
 * exactly the hard-coded value the token rule exists to prevent.
 */
export const TextColorMark = Mark.create({
  name: 'textColor',

  addAttributes() {
    return {
      text: {
        default: null,
        parseHTML: (element) => readColor(element.getAttribute('data-text-color')),
        renderHTML: (attributes) => {
          const color = readColor(attributes.text);
          return color === null ? {} : { 'data-text-color': color };
        },
      },

      background: {
        default: null,
        parseHTML: (element) => readColor(element.getAttribute('data-background-color')),
        renderHTML: (attributes) => {
          const color = readColor(attributes.background);
          return color === null ? {} : { 'data-background-color': color };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-text-color]' }, { tag: 'span[data-background-color]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    const name = this.name;

    /**
     * One axis set, or cleared, without disturbing the other.
     *
     * Written once and bound twice, because the interesting half is the clearing rule and two
     * copies of it is one copy that gets fixed.
     */
    const setAxis =
      (axis: ColorAxis) =>
      (color: TextColor): Command =>
      ({ commands, editor }) => {
        if (color !== DEFAULT_COLOR) {
          // `setMark` merges with the attributes already on the mark, so the other axis
          // survives a change to this one.
          return commands.setMark(name, { [axis]: color });
        }

        // `default` clears. The mark stays only while the other axis still carries something,
        // and goes entirely otherwise, so no empty mark lingers in the document.
        //
        // `editor.getAttributes` reads the editor's real state, not the chainable state this
        // command is running against - harmless for the single-command chain the bubble menu
        // sends, and for the undispatched `can()` probe it also serves, because neither has an
        // earlier step to disagree with. Chaining this *after* something that changes the mark
        // would read the state from before that change; use the transaction's own selection
        // marks if that day comes.
        const other: unknown = editor.getAttributes(name)[OTHER_AXIS[axis]];
        return axisAbsent(other)
          ? commands.unsetMark(name)
          : commands.setMark(name, { [axis]: null });
      };

    return {
      setTextColor: setAxis('text'),
      setTextBackground: setAxis('background'),
    };
  },
});

/**
 * Reserved for a comment thread's range; nothing writes it.
 *
 * **Threads do not use this mark.** They live in Postgres (`note_comment`), anchored by Yjs
 * relative positions the web editor decodes into highlight decorations (`comment-anchors.ts` in
 * `@nix/web-editor`). Relative positions follow the CRDT through concurrent edits, and keeping
 * the anchor out of the document means commenting never edits the note, so a Commenter who cannot
 * write the body can still comment. The mark stays in the schema so documents that carry it still
 * parse.
 *
 * `inclusive: false` so typing at the edge of a marked range does not extend it, and
 * `excludes: ''` so overlapping ranges are legal.
 */
export const CommentMark = Mark.create({
  name: 'comment',

  inclusive: false,

  excludes: '',

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-comment-thread'),
        renderHTML: (attributes) =>
          typeof attributes.threadId === 'string' && attributes.threadId.length > 0
            ? { 'data-comment-thread': attributes.threadId }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-thread]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});
