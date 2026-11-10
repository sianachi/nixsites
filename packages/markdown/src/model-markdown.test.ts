import { describe, expect, it } from 'vitest';
import { cleanModelMarkdown } from './model-markdown.js';
import { markdownToDocument } from './from-markdown.js';
import { documentToMarkdown } from './to-markdown.js';
import { MODEL_OUTPUTS } from './fixtures/model-outputs.js';

interface Json {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function walk(node: Json, visit: (node: Json, insideCode: boolean) => void, code = false): void {
  visit(node, code);
  const inside = code || node.type === 'codeBlock';
  node.content?.forEach((child) => {
    walk(child, visit, inside);
  });
}

function convert(markdown: string): Json {
  const result = markdownToDocument(cleanModelMarkdown(markdown));
  if (!result.ok) throw new Error(result.reason);
  return result.doc as Json;
}

describe('cleanModelMarkdown', () => {
  it('unwraps a fence that is the whole text only', () => {
    expect(cleanModelMarkdown('```markdown\n# A\n\ntext\n```')).toBe('# A\n\ntext');
    expect(cleanModelMarkdown('```md\nx\n```\n')).toBe('x');
    expect(cleanModelMarkdown('Intro\n\n```markdown\n# A\n```')).toBe(
      'Intro\n\n```markdown\n# A\n```',
    );
    expect(cleanModelMarkdown('```js\nx\n```')).toBe('```js\nx\n```');
  });

  it('adds a blank line before a list or table after a paragraph line', () => {
    expect(cleanModelMarkdown('Steps\n2. two\n3. three')).toBe('Steps\n\n2. two\n3. three');
    expect(cleanModelMarkdown('Steps\n- a\n- b')).toBe('Steps\n\n- a\n- b');
    expect(cleanModelMarkdown('T\n| a |\n| - |')).toBe('T\n\n| a |\n| - |');
  });

  it('leaves lists, tables, headings and code fences alone', () => {
    const same = '# H\n- a\n  - b\n\n- c\n> q\n- d\n```\ntext\n- not a list\n```\n| a |\n| - |';
    expect(cleanModelMarkdown(same)).toBe(same);
  });
});

describe('Markdown parser additions', () => {
  it('reads task items with their checked state and round-trips them', () => {
    const doc = convert('- [ ] one\n- [x] two\n- [X] three');
    const items = doc.content?.[0]?.content ?? [];
    expect(doc.content?.[0]?.type).toBe('taskList');
    expect(items.map((item) => item.attrs?.checked)).toEqual([false, true, true]);
    expect(items[0]?.content?.[0]?.content?.[0]?.text).toBe('one');
    const back = documentToMarkdown(doc);
    expect(back.markdown).toBe('- [ ] one\n- [x] two\n- [x] three');
    expect(back.losses).toEqual([]);
  });

  it('keeps a mixed list a bullet list', () => {
    expect(convert('- [ ] one\n- plain').content?.[0]?.type).toBe('bulletList');
  });

  it('reads a callout marker that opens the first paragraph', () => {
    const doc = convert('> [!warning] Careful\n> now');
    const callout = doc.content?.[0];
    expect(callout?.type).toBe('callout');
    expect(callout?.attrs?.tone).toBe('warning');
    expect(JSON.stringify(callout?.content)).toContain('Careful');
    expect(JSON.stringify(callout?.content)).not.toContain('[!');
  });

  it.each(['**Note:**text', '**"hi"**there', '**(x)**next'])('makes %s bold', (source) => {
    const doc = convert(source);
    const texts: Json[] = [];
    walk(doc, (node) => {
      if (node.type === 'text') texts.push(node);
    });
    expect(texts.some((t) => t.marks?.some((m) => m.type === 'bold'))).toBe(true);
    expect(texts.map((t) => t.text).join('')).not.toContain('*');
  });

  it('does not bold a span that starts or ends with a space', () => {
    expect(JSON.stringify(convert('a ** b ** c'))).not.toContain('"bold"');
  });

  it('links explicit URLs only and never an unsafe scheme', () => {
    const marks = (source: string): string[] => {
      const found: string[] = [];
      walk(convert(source), (node) => {
        node.marks?.forEach((m) => found.push(`${m.type}:${JSON.stringify(m.attrs?.href ?? '')}`));
      });
      return found;
    };
    expect(marks('see https://example.com/a.')).toEqual(['link:"https://example.com/a"']);
    expect(marks('open notes.md and a@b.co')).toEqual([]);
    expect(marks('javascript:alert(1)')).toEqual([]);
  });

  it('turns <br> into a hard break and keeps other tags as text', () => {
    const doc = convert('a<br>b <span>c</span>');
    const types: string[] = [];
    walk(doc, (node) => types.push(node.type));
    expect(types).toContain('hardBreak');
    expect(JSON.stringify(doc)).toContain('<span>');
  });
});

describe('review fixes', () => {
  it('unwraps a markdown fence only when it is the whole text', () => {
    const mixed = '```md\n# Example\n```\n\nThat renders a heading.\n\n```js\nx\n```';
    expect(cleanModelMarkdown(mixed)).toBe(mixed);
    expect(cleanModelMarkdown('```md\n# T\n```')).toBe('# T');
  });

  it('keeps ** out of code spans, links and autolinks', () => {
    for (const src of [
      '**[link](http://a.com/**x)**',
      '**a `x**y` b**',
      '**a <https://x.com/**b> c**',
    ]) {
      const out = JSON.stringify(convert(src));
      expect(out).not.toContain('"text":"**"');
    }
    expect(JSON.stringify(convert('**[link](http://a.com/**x)**'))).toContain('"link"');
  });

  it('round-trips a literal <br>', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use <br> to break' }] }],
    };
    const md = documentToMarkdown(doc);
    const back = markdownToDocument(
      typeof md === 'string' ? md : (md as { markdown: string }).markdown,
    );
    expect(JSON.stringify(back.ok && back.doc)).not.toContain('hardBreak');
  });

  it('does not count ordinary text as raw syntax', () => {
    for (const src of [
      'Price $5-$10 or $5/$10',
      '#1 priority',
      'if x<y and y>z',
      'Use List<String> here',
      'a==b and c==d',
      '2 ** 3 ** 4',
    ]) {
      const result = markdownToDocument(src);
      expect(result.ok && result.scan.rawSyntax).toBeUndefined();
    }
  });
});

describe('raw syntax scan', () => {
  it('counts kinds outside code and never reports text', () => {
    const result = markdownToDocument('a **b\n\n`**x**` <u>u</u> $a$\n\n```\n**c** ==d==\n```');
    if (!result.ok) throw new Error(result.reason);
    expect(result.scan.rawSyntax).toEqual({ 'bold-marker': 1, 'html-tag': 2, math: 1 });
  });

  it('adds nothing for clean Markdown', () => {
    const result = markdownToDocument('# T\n\n**b** costs $5 and $10');
    expect(result.ok && result.scan.rawSyntax).toBeUndefined();
  });
});

describe('model output fixtures', () => {
  it.each(MODEL_OUTPUTS.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const doc = convert(entry.markdown);
    const nodes = new Set<string>();
    const marks = new Set<string>();
    walk(doc, (node) => {
      nodes.add(node.type);
      node.marks?.forEach((m) => marks.add(m.type));
    });
    for (const type of entry.nodes) expect(nodes, `node ${type}`).toContain(type);
    for (const type of entry.marks ?? []) expect(marks, `mark ${type}`).toContain(type);
    // The scan is the one definition of raw syntax; only the known-raw cases may report any.
    const result = markdownToDocument(cleanModelMarkdown(entry.markdown));
    const kinds = result.ok ? Object.keys(result.scan.rawSyntax ?? {}).sort() : [];
    expect(kinds).toEqual([...(entry.rawKinds ?? [])].sort());
  });
});
