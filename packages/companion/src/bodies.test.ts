import { describe, expect, it, vi } from 'vitest';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';
import { nixSchema } from '@nix/editor-schema';
import { documentToMarkdown, markdownToDocument } from '@nix/markdown';
import type { NixClient } from '@nix/api-client';
import { createCompanionBodies } from './bodies.js';
import type { BodyEdit } from './ports.js';
import { WorkspaceToolRefusal } from './tool-args.js';

const itemId = '22222222-2222-4222-8222-222222222222';
function encode(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

/** A note held in a real Y.Doc, served page by page as the collab endpoint would, with every
 * write applied back onto it. */
function noteFrom(content: unknown) {
  const original = new Y.Doc();
  prosemirrorJSONToYXmlFragment(nixSchema, content, original.getXmlFragment('default'));
  const query = vi.fn().mockImplementation(() =>
    Promise.resolve({
      hasMore: false,
      updates: [{ seq: '1', update: encode(Y.encodeStateAsUpdate(original)) }],
    }),
  );
  const execute = vi.fn().mockImplementation((endpoint: { body: { update: string } }) => {
    Y.applyUpdate(
      original,
      Uint8Array.from(atob(endpoint.body.update), (char) => char.charCodeAt(0)),
    );
    return Promise.resolve({ seq: '2' });
  });
  const bodies = createCompanionBodies({ query, execute } as unknown as NixClient);
  const fragment = original.getXmlFragment('default');
  return {
    original,
    fragment,
    bodies,
    execute,
    markdown: () =>
      documentToMarkdown(yXmlFragmentToProseMirrorRootNode(fragment, nixSchema).toJSON()).markdown,
  };
}

function noteFromMarkdown(markdown: string) {
  const parsed = markdownToDocument(markdown);
  if (!parsed.ok) throw new Error('fixture Markdown is invalid');
  return noteFrom(parsed.doc);
}

/** The Yjs identity (client and clock of the item that created it) of every element in the
 * fragment, however deeply nested. */
function elementIds(parent: Y.XmlFragment | Y.XmlElement): string[] {
  const ids: string[] = [];
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const id = child._item?.id;
    if (id) ids.push(`${String(id.client)}:${String(id.clock)}`);
    ids.push(...elementIds(child));
  }
  return ids;
}

function idOf(element: Y.XmlElement): string {
  const id = element._item?.id;
  if (!id) throw new Error('element has no identity');
  return `${String(id.client)}:${String(id.clock)}`;
}

function topLevel(fragment: Y.XmlFragment): Y.XmlElement[] {
  return fragment.toArray().filter((node): node is Y.XmlElement => node instanceof Y.XmlElement);
}

async function edit(note: ReturnType<typeof noteFrom>, change: BodyEdit) {
  const signal = new AbortController().signal;
  const plan = await note.bodies.planEdit(itemId, change, signal);
  const result = await note.bodies.applyEdit(itemId, change, plan.fingerprint, signal);
  return { plan, result };
}

const TRIP = [
  '# Trip',
  '',
  'Intro with **bold** text.',
  '',
  '## Packing',
  '',
  '- Passport',
  '- Clothes',
  '  - Socks',
  '  - Shirts',
  '',
  '```sh',
  'pack --all',
  '```',
  '',
  '| Item | Count |',
  '| --- | --- |',
  '| Socks | 4 |',
  '',
  '### Extras',
  '',
  'Snacks for the road.',
  '',
  '## Budget',
  '',
  'Total is *400*.',
  '',
  '## Notes',
  '',
  'First note.',
].join('\n');

describe('companion note bodies', () => {
  it('tells the model which syntax stayed plain text, without quoting the note', async () => {
    const note = noteFrom({ type: 'doc', content: [{ type: 'paragraph' }] });
    const result = (await note.bodies.append(
      itemId,
      'Some <u>secret</u> here',
      new AbortController().signal,
    )) as { markdownChanges: { rawSyntax?: Record<string, number> }; rawSyntaxNote?: string };
    expect(result.markdownChanges.rawSyntax).toEqual({ 'html-tag': 2 });
    expect(result.rawSyntaxNote).toContain('html-tag x2');
    expect(result.rawSyntaxNote).not.toContain('secret');
  });

  it('appends content while preserving the existing rich body', async () => {
    const note = noteFrom({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Keep this', marks: [{ type: 'bold' }] }],
        },
      ],
    });
    await note.bodies.append(itemId, 'Added by the pet', new AbortController().signal);
    const json = yXmlFragmentToProseMirrorRootNode(note.fragment, nixSchema).toJSON() as {
      content: unknown[];
    };
    expect(json.content).toHaveLength(2);
    expect(json.content[0]).toMatchObject({
      content: [{ text: 'Keep this', marks: [{ type: 'bold' }] }],
    });
    expect(JSON.stringify(json.content[1])).toContain('Added by the pet');
    note.original.destroy();
  });
  it('refuses incomplete history instead of writing over an uncertain base', async () => {
    const query = vi.fn().mockResolvedValue({ hasMore: true, updates: [] });
    const execute = vi.fn();
    const bodies = createCompanionBodies({ query, execute } as unknown as NixClient);
    await expect(bodies.append(itemId, 'New text', new AbortController().signal)).rejects.toThrow(
      'incomplete',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('replacing a section', () => {
  it('replaces nested lists, a code block, a table and a subsection up to the next same-level heading, keeping the heading', async () => {
    const note = noteFromMarkdown(TRIP);
    const { plan, result } = await edit(note, {
      kind: 'section',
      heading: 'packing',
      markdown: '- Passport\n- Tickets',
    });
    expect(plan.before).toContain('## Packing');
    expect(plan.before).toContain('  - Shirts');
    expect(plan.before).toContain('pack --all');
    expect(plan.before).toContain('| Socks | 4 |');
    expect(plan.before).toContain('### Extras');
    expect(plan.before).not.toContain('Budget');
    expect(plan.after).toBe('## Packing\n\n- Passport\n- Tickets');
    // Bullet list, code block, table, the Extras heading and its paragraph.
    expect(result).toMatchObject({ replaced: true, blocksRemoved: 5, blocksAdded: 1 });
    const after = note.markdown();
    expect(after).toContain(
      '# Trip\n\nIntro with **bold** text.\n\n## Packing\n\n- Passport\n- Tickets\n\n## Budget',
    );
    expect(after).not.toContain('Snacks');
    expect(after).toContain('Total is *400*.');
    note.original.destroy();
  });

  it('replaces the heading too when the new Markdown starts with one', async () => {
    const note = noteFromMarkdown(TRIP);
    const { result } = await edit(note, {
      kind: 'section',
      heading: '## Budget',
      markdown: '## Costs\n\nTotal is 450.',
    });
    expect(result).toMatchObject({ blocksRemoved: 2, blocksAdded: 2 });
    const after = note.markdown();
    expect(after).toContain('## Costs\n\nTotal is 450.\n\n## Notes');
    expect(after).not.toContain('Budget');
    note.original.destroy();
  });

  it('runs to the end of the note when no later heading closes the section', async () => {
    const note = noteFromMarkdown(TRIP);
    await edit(note, { kind: 'section', heading: 'Notes', markdown: 'Second note.' });
    expect(note.markdown().trim().endsWith('## Notes\n\nSecond note.')).toBe(true);
    note.original.destroy();
  });

  it('keeps the Yjs identity of every block outside the section', async () => {
    for (const heading of ['Trip', 'Packing', 'Extras', 'Budget', 'Notes']) {
      const note = noteFromMarkdown(TRIP);
      const before = topLevel(note.fragment).map(idOf);
      const index = topLevel(note.fragment).findIndex(
        (element) => element.nodeName === 'heading' && element.toJSON().includes(heading),
      );
      const { result } = await edit(note, { kind: 'section', heading, markdown: 'Replaced.' });
      const after = topLevel(note.fragment).map(idOf);
      const start = index + 1;
      const end = start + result.blocksRemoved;
      expect(after.slice(0, start)).toEqual(before.slice(0, start));
      expect(after.slice(start + result.blocksAdded)).toEqual(before.slice(end));
      expect(after.slice(start, start + result.blocksAdded)).not.toContain(before[start]);
      note.original.destroy();
    }
  });

  it('refuses a missing heading and lists the headings it has', async () => {
    const note = noteFromMarkdown(TRIP);
    const change: BodyEdit = { kind: 'section', heading: 'Itinerary', markdown: 'x' };
    const refusal = note.bodies.planEdit(itemId, change, new AbortController().signal);
    await expect(refusal).rejects.toBeInstanceOf(WorkspaceToolRefusal);
    await expect(refusal).rejects.toThrow(
      'No heading "Itinerary" was found. Headings in this note: "Trip", "Packing", "Extras", "Budget", "Notes".',
    );
    expect(note.execute).not.toHaveBeenCalled();
    note.original.destroy();
  });

  it('refuses a heading that appears more than once and says where each one is', async () => {
    const note = noteFromMarkdown('# Week 1\n\n## Notes\n\nOne.\n\n# Week 2\n\n## Notes\n\nTwo.');
    const change: BodyEdit = { kind: 'section', heading: 'notes', markdown: 'x' };
    await expect(
      note.bodies.applyEdit(itemId, change, 'any', new AbortController().signal),
    ).rejects.toThrow(
      'The heading "notes" appears 2 times (level 2 under "Week 1"; level 2 under "Week 2").',
    );
    expect(note.execute).not.toHaveBeenCalled();
    note.original.destroy();
  });

  it('refuses when the section changed after the preview was approved', async () => {
    const note = noteFromMarkdown(TRIP);
    const change: BodyEdit = { kind: 'section', heading: 'Budget', markdown: 'Total is 450.' };
    const signal = new AbortController().signal;
    const plan = await note.bodies.planEdit(itemId, change, signal);
    const budget = topLevel(note.fragment).findIndex((element) =>
      element.toJSON().includes('Total is'),
    );
    note.fragment.delete(budget, 1);
    await expect(
      note.bodies.applyEdit(itemId, change, plan.fingerprint, signal),
    ).rejects.toMatchObject({
      message: 'The note changed since you approved this. Read it again before editing.',
      ownerMessage: 'The note changed after you approved this, so nothing was edited.',
    });
    expect(note.execute).not.toHaveBeenCalled();
    note.original.destroy();
  });

  it('still applies when only text outside the section changed', async () => {
    const note = noteFromMarkdown(TRIP);
    const change: BodyEdit = { kind: 'section', heading: 'Budget', markdown: 'Total is 450.' };
    const signal = new AbortController().signal;
    const plan = await note.bodies.planEdit(itemId, change, signal);
    note.fragment.delete(1, 1);
    await note.bodies.applyEdit(itemId, change, plan.fingerprint, signal);
    expect(note.markdown()).toContain('## Budget\n\nTotal is 450.');
    note.original.destroy();
  });
});

describe('replacing a passage', () => {
  it('rewrites only the nested list item that holds the text', async () => {
    const note = noteFromMarkdown(TRIP);
    const before = elementIds(note.fragment);
    const { plan, result } = await edit(note, {
      kind: 'passage',
      find: 'Shirts',
      replace: 'T-shirts',
    });
    expect(plan).toMatchObject({
      scope: 'list item',
      before: 'Shirts',
      after: 'T-shirts',
      // "S" became "T-s": the round trip keeps the rest, so only that run is marked.
      beforeRange: { start: 0, end: 1 },
      afterRange: { start: 0, end: 3 },
    });
    expect(result).toMatchObject({ replaced: true, blocksRemoved: 1, blocksAdded: 1 });
    expect(note.markdown()).toContain('- Clothes\n\n  - Socks\n  - T-shirts');
    const after = new Set(elementIds(note.fragment));
    // Only the one paragraph is new: the list, both list items and every other block survive.
    expect(before.filter((id) => !after.has(id))).toHaveLength(1);
    note.original.destroy();
  });

  it('edits text inside a code block and a table cell', async () => {
    const note = noteFromMarkdown(TRIP);
    await edit(note, { kind: 'passage', find: 'pack --all', replace: 'pack --light' });
    await edit(note, { kind: 'passage', find: 'Count', replace: 'Quantity' });
    const after = note.markdown();
    expect(after).toContain('```sh\npack --light\n```');
    expect(after).toContain('| Item | Quantity |');
    note.original.destroy();
  });

  it('keeps Markdown marks inside the edited block and identities everywhere else', async () => {
    for (const find of ['Intro with', 'Passport', 'Item', 'Snacks', 'Total is', 'First']) {
      const note = noteFromMarkdown(TRIP);
      const before = elementIds(note.fragment);
      await edit(note, { kind: 'passage', find, replace: `${find} (edited)` });
      const after = new Set(elementIds(note.fragment));
      expect(before.filter((id) => !after.has(id))).toHaveLength(1);
      expect(note.markdown()).toContain(`${find} (edited)`);
      note.original.destroy();
    }
    const note = noteFromMarkdown(TRIP);
    await edit(note, { kind: 'passage', find: 'Intro with', replace: 'Opening with' });
    expect(note.markdown()).toContain('Opening with **bold** text.');
    note.original.destroy();
  });

  it('lets a top-level paragraph become several blocks or none', async () => {
    const note = noteFromMarkdown(TRIP);
    const { result } = await edit(note, {
      kind: 'passage',
      find: 'First note.',
      replace: 'First note.\n\nSecond note.',
    });
    expect(result.blocksAdded).toBe(2);
    expect(note.markdown()).toContain('First note.\n\nSecond note.');
    const removed = await edit(note, { kind: 'passage', find: 'Second note.', replace: '' });
    expect(removed.result).toMatchObject({ blocksRemoved: 1, blocksAdded: 0 });
    expect(note.markdown()).not.toContain('Second note.');
    note.original.destroy();
  });

  it('refuses text that is not found, giving the reason', async () => {
    const note = noteFromMarkdown(TRIP);
    const refusal = note.bodies.planEdit(
      itemId,
      { kind: 'passage', find: '- Passport', replace: 'x' },
      new AbortController().signal,
    );
    await expect(refusal).rejects.toBeInstanceOf(WorkspaceToolRefusal);
    await expect(refusal).rejects.toThrow('"- Passport" was not found');
    expect(note.execute).not.toHaveBeenCalled();
    note.original.destroy();
  });

  it('refuses text spread across two blocks', async () => {
    const note = noteFromMarkdown(TRIP);
    await expect(
      note.bodies.planEdit(
        itemId,
        { kind: 'passage', find: 'Passport\nClothes', replace: 'x' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('was not found');
    note.original.destroy();
  });

  it('refuses text that appears more than once, with the count', async () => {
    const note = noteFromMarkdown(TRIP);
    await expect(
      note.bodies.applyEdit(
        itemId,
        { kind: 'passage', find: 'Socks', replace: 'Sox' },
        'any',
        new AbortController().signal,
      ),
    ).rejects.toThrow('"Socks" appears 2 times.');
    expect(note.execute).not.toHaveBeenCalled();
    note.original.destroy();
  });

  it('refuses a nested replacement that would change the shape of its list', async () => {
    const note = noteFromMarkdown(TRIP);
    await expect(
      note.bodies.planEdit(
        itemId,
        { kind: 'passage', find: 'Shirts', replace: 'Shirts\n\nand ties' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('would change the shape of the list');
    note.original.destroy();
  });

  it('reports formatting Markdown cannot keep in the edited block', async () => {
    const note = noteFrom({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: 'center' },
          content: [{ type: 'text', text: 'Centred line' }],
        },
      ],
    });
    const plan = await note.bodies.planEdit(
      itemId,
      { kind: 'passage', find: 'Centred', replace: 'Centered' },
      new AbortController().signal,
    );
    expect(plan.losses.map((loss) => loss.kind)).toContain('alignment-dropped');
    note.original.destroy();
  });

  it('names the block a passage sits in', async () => {
    const note = noteFromMarkdown(TRIP);
    const signal = new AbortController().signal;
    const scopeOf = async (find: string) =>
      (await note.bodies.planEdit(itemId, { kind: 'passage', find, replace: 'x' }, signal)).scope;
    expect(await scopeOf('Intro with')).toBe('paragraph');
    expect(await scopeOf('Extras')).toBe('heading');
    expect(await scopeOf('pack --all')).toBe('code block');
    expect(await scopeOf('Count')).toBe('table cell');
    expect(await scopeOf('Passport')).toBe('list item');
    note.original.destroy();
  });

  it('gives every refusal an owner sentence with no tool names', async () => {
    const note = noteFromMarkdown('# Week 1\n\n## Notes\n\nOne.\n\n# Week 2\n\n## Notes\n\nOne.');
    const signal = new AbortController().signal;
    const changes: BodyEdit[] = [
      { kind: 'section', heading: 'Missing', markdown: 'x' },
      { kind: 'section', heading: 'Notes', markdown: 'x' },
      { kind: 'section', heading: 'Week 1', markdown: ' ' },
      { kind: 'passage', find: 'absent', replace: 'x' },
      { kind: 'passage', find: 'One.', replace: 'x' },
    ];
    for (const change of changes) {
      const refusal = await note.bodies
        .planEdit(itemId, change, signal)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(WorkspaceToolRefusal);
      const owner = (refusal as WorkspaceToolRefusal).ownerMessage ?? '';
      expect(owner).toMatch(/nothing was edited|Nothing was edited/);
      expect(owner).not.toMatch(/nix_/);
    }
    note.original.destroy();
  });

  it('cleans only the model text in a passage, not the owner block', async () => {
    const note = noteFromMarkdown('```markdown\n# Template\n\n- [ ] item\n```\n\nTail');
    const plan = await note.bodies.planEdit(
      itemId,
      { kind: 'passage', find: 'Template', replace: 'Form' },
      new AbortController().signal,
    );
    expect(plan.blocksAdded).toBe(1);
    expect(plan.scope).toBe('code block');
    note.original.destroy();
  });

  it('does not flag the owner text in a passage as raw syntax', async () => {
    const note = noteFromMarkdown('Use List<String> here today.');
    const plan = await note.bodies.planEdit(
      itemId,
      { kind: 'passage', find: 'today', replace: 'now' },
      new AbortController().signal,
    );
    expect(plan.markdownChanges.rawSyntax).toBeUndefined();
    note.original.destroy();
  });
});
