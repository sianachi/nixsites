import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TEXT_COLORS, TOGGLE_LEVELS, nixSchema } from '@nix/editor-schema';

import { calloutClass, headingClass, proseClasses, proseRoot } from '../../editor/prose';
import {
  DOCUMENT_HEADING_STEP,
  DOCUMENT_BODY_STEP,
  DOCUMENT_SECONDARY_STEP,
  TOGGLE_SUMMARY_STEP,
} from '../../editor/prose-type';

/**
 * The document's appearance, as class strings.
 *
 * These exist because of a bug worth remembering: the editor applied a class called `nix-prose`
 * that was defined nowhere, and Tailwind's reset strips heading sizes, list markers, blockquote
 * indents and table borders. Every block in a note rendered as identical plain text, so the rich
 * editor did not look plain - it looked broken.
 *
 * A class string cannot be tested by rendering it, so what is asserted here is what can go wrong
 * without anybody noticing: a node the schema defines with no appearance at all, and an arbitrary
 * value creeping back in. The second is the whole point of the phase these were written in, and a
 * regex sweep is a better guard than any number of examples.
 */

const editorDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'editor');

/**
 * Both files, read as one string.
 *
 * The type steps moved out to `prose-type.ts` when the toggle summaries and the real headings had
 * to be made to agree in code rather than in a comment, so a sweep that read only `prose.ts` would
 * now be sweeping the half of the pair with no sizes left in it - passing for the wrong reason.
 */
const source = [
  readFileSync(join(editorDir, 'prose.ts'), 'utf8'),
  readFileSync(join(editorDir, 'prose-type.ts'), 'utf8'),
].join('\n');

describe('coverage of the schema', () => {
  /**
   * Nodes and marks whose appearance is somebody else's business.
   *
   * `text` has no element of its own. The table and list parts, the column and the two halves
   * of a toggle are drawn by their container. `hardBreak` is a `<br>` with no box. `heading`
   * and `callout` depend on an attribute and have their own functions below.
   *
   * Everything else is derived from the schema rather than listed, which is the point: a hand
   * written list is a list somebody has to remember to extend, and the failure when they do
   * not is a node that renders with Tailwind's reset and nothing else - silently, because the
   * test that should have caught it was the thing that went stale.
   */
  const STYLED_BY_SOMETHING_ELSE = new Set([
    'doc',
    'text',
    'hardBreak',
    'heading',
    'callout',
    'column',
    'detailsSummary',
    'detailsContent',
  ]);

  const covered = [...Object.keys(nixSchema.nodes), ...Object.keys(nixSchema.marks)].filter(
    (name) => !STYLED_BY_SOMETHING_ELSE.has(name),
  );

  it.each(covered)('gives %s an appearance', (name) => {
    // A node with no entry renders with Tailwind's reset and nothing else, which is precisely the
    // state this file exists to end.
    expect(proseClasses[name], name).toBeDefined();
  });

  it('leaves the nodes with nothing to style alone', () => {
    // A hard break is a `<br>`: it has no box, no text of its own and nothing a class could
    // change. An entry for it would be a class nobody could see the effect of, which is worse
    // than none.
    expect(proseClasses.hardBreak).toBeUndefined();
  });

  it('leaves heading and callout to their own functions', () => {
    // Their appearance depends on an attribute, which a fixed string cannot express. Present in
    // this map, they would silently win over the renderer that reads the attribute.
    expect(proseClasses.heading).toBeUndefined();
    expect(proseClasses.callout).toBeUndefined();
  });
});

describe('headings', () => {
  it('makes the three levels distinguishable', () => {
    const levels = [1, 2, 3].map((level) => headingClass(level));

    // A hierarchy nobody can see is not a hierarchy. Distinct strings are the weakest form of that
    // assertion and the only one available without a browser.
    expect(new Set(levels).size).toBe(3);
  });

  it('renders a level this build does not define rather than dropping it', () => {
    // A document from a newer build shows its structure at the wrong rank instead of losing it.
    expect(headingClass(9)).toBe(headingClass(1));
    expect(headingClass(0)).toBe(headingClass(1));
  });
});

describe('callouts', () => {
  it('distinguishes the four tones', () => {
    const tones = ['note', 'tip', 'warning', 'danger'].map((tone) => calloutClass(tone));

    expect(new Set(tones).size).toBe(4);
  });

  it('falls back to note for a tone this build does not know', () => {
    // Matching the schema's own reading of the attribute: readable in the wrong tone beats
    // unreadable in no tone.
    expect(calloutClass('interstellar')).toBe(calloutClass('note'));
  });
});

describe('the values these strings are built from', () => {
  it('names no arbitrary type size', () => {
    // The defect this phase exists to remove. Twelve hand-picked sizes across the app were why it
    // read as unfinished; a `text-[15px]` here would put the thirteenth back.
    expect(source).not.toMatch(/text-\[\d/);
  });

  it('names no raw colour', () => {
    // A guard script enforces this repository-wide, but a hex in a class string is worth failing
    // here too, where the message says which file to look in.
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('uses the type scale', () => {
    // Not merely the absence of literals: the strings have to reach for the scale, or the document
    // inherits whatever the browser felt like.
    expect(source).toMatch(/\btext-(2xs|xs|sm|base|md|lg|xl|2xl|3xl)\b/);
  });

  it('sizes a toggle summary at the heading rank it presents as', () => {
    // Two tables spelled out separately, because a variant-prefixed class has to appear complete
    // in the source for Tailwind to emit it at all - see prose-type.ts. This is what stops the
    // duplication drifting into a document with two hierarchies.
    for (const level of [1, 2, 3] as const) {
      expect(TOGGLE_SUMMARY_STEP[level]).toContain(`:${DOCUMENT_HEADING_STEP[level]}`);
      expect(proseRoot).toContain(TOGGLE_SUMMARY_STEP[level]);
      expect(headingClass(level)).toContain(DOCUMENT_HEADING_STEP[level]);
    }
  });

  it('dresses the table from its wrapper, at the secondary step', () => {
    // A resizable table is built by prosemirror-tables' own node view, which never receives the
    // `table` entry of `proseClasses`; the look has to reach the element from the root. The
    // step is spelled out with the variant, so this is what keeps it the secondary step.
    for (const step of DOCUMENT_SECONDARY_STEP.split(' ')) {
      const separator = step.lastIndexOf(':') + 1;
      expect(proseRoot).toContain(
        `${step.slice(0, separator)}[&_.tableWrapper>table]:${step.slice(separator)}`,
      );
    }
    expect(proseRoot).toContain('[&_.tableWrapper>table]:w-full');
    expect(proseRoot).toContain('[&_.tableWrapper]:overflow-x-auto');
  });

  it('keeps editable touch text above the mobile focus-zoom threshold', () => {
    expect(DOCUMENT_BODY_STEP).toBe('text-lg sm:not-any-pointer-coarse:text-md');
    expect(DOCUMENT_SECONDARY_STEP).toBe('text-lg sm:not-any-pointer-coarse:text-base');
    expect(proseRoot).toContain('[&_.tableWrapper>table]:text-lg');
    expect(proseRoot).toContain('sm:not-any-pointer-coarse:[&_.tableWrapper>table]:text-base');
  });

  it('keeps the document to a measure', () => {
    // Text running the full width of a wide pane is measurably harder to read.
    expect(proseRoot).toContain('max-w-prose');
  });

  it('styles what the ProseMirror runtime draws and no stylesheet covers', () => {
    // The selection, the gap cursor and the column resize handle come from packages whose
    // stylesheets we do not import, so without these they are in the DOM and invisible.
    expect(proseRoot).toContain('selection:');
    expect(proseRoot).toContain('ProseMirror-gapcursor');
    expect(proseRoot).toContain('column-resize-handle');
  });
});

describe('the grounds', () => {
  it('needs no dark variant anywhere', () => {
    // A component reaching for `dark:` has reached past the tokens for a colour. The semantic
    // roles move with the ground, so correct use of them is correct on both.
    expect(source).not.toContain('dark:');
  });
});

describe('the text palette', () => {
  /** Every utility this file attaches to a value of `attribute`, as one string. */
  function renderingOf(attribute: string, value: string): string {
    const escaped = `\\[&_\\[${attribute}="${value}"\\]\\]:`;
    return [...source.matchAll(new RegExp(`${escaped}([\\w-/.]+)`, 'g'))]
      .map((match) => match[1])
      .sort()
      .join(' ');
  }

  it('renders every colour differently from every other colour', () => {
    // The assertion that was missing when the palette briefly had six names and three
    // renderings - `success`, `warning` and `danger` were byte-identical to each other or to
    // `bold`. A picker offering choices the renderer collapses is a control that lies, and the
    // choice is stored in the document permanently, so it cannot be quietly narrowed later.
    //
    // `default` is absent from both maps on purpose: it is the inherited appearance, so having
    // no rule of its own is exactly right.
    for (const attribute of ['data-text-color', 'data-background-color']) {
      const named = TEXT_COLORS.filter((color) => color !== 'default');
      const rendered = named.map((color) => renderingOf(attribute, color));

      expect(
        rendered.filter((rule) => rule.length === 0),
        `${attribute} has unstyled colours`,
      ).toEqual([]);
      expect(new Set(rendered).size, `${attribute} renders two colours the same`).toBe(
        named.length,
      );
    }
  });

  it('gives a toggle heading the size of the real heading of that rank', () => {
    // Otherwise a document has two visual hierarchies: headings, and toggle headings that all
    // look alike. The attribute is in the schema either way, so the only question is whether
    // anything reads it.
    for (const level of TOGGLE_LEVELS) {
      expect(source, `toggle level ${String(level)} is stored and never drawn`).toContain(
        `[data-toggle-level="${String(level)}"]`,
      );
    }
  });
});
