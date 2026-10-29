import { describe, expect, it } from 'vitest';

import { createParser } from '@openuidev/react-lang';

import { nixLibrary } from '../../openui/library';
import { openUiPrompt, PROMPT_EXAMPLES } from '../../openui/prompt';

describe('the pet’s OpenUI instructions', () => {
  it('match the catalog the Go worker embeds (regenerate with vitest -u)', async () => {
    await expect(openUiPrompt()).toMatchFileSnapshot(
      '../../../../../apps/go-workers/internal/companion/catalog/openui.txt',
    );
  });

  it('also write the library schema the chat evals parse replies with', async () => {
    await expect(`${JSON.stringify(nixLibrary.toJSONSchema(), null, 2)}\n`).toMatchFileSnapshot(
      '../../../../structure-spec/evals/openui-library.json',
    );
  });

  it('teach only examples that parse cleanly against the library', () => {
    const parser = createParser(nixLibrary.toJSONSchema());
    for (const example of PROMPT_EXAMPLES) {
      const result = parser.parse(example);
      expect(result.meta.errors, example).toEqual([]);
      expect(result.root, example).not.toBeNull();
    }
  });

  it('name every registered component and query tool', () => {
    const prompt = openUiPrompt();
    for (const name of [
      'Stack',
      'Grid',
      'Button',
      'NumberInput',
      'Select',
      'ItemList',
      'Chart',
      'Form',
      'TextArea',
      '@Today',
      '@DaysBetween',
    ])
      expect(prompt).toContain(`${name}(`);
    for (const tool of ['search', 'list_items', 'read_calendar']) expect(prompt).toContain(tool);
    expect(prompt).toContain('openui-lang');
    expect(prompt).toContain('openui-lang patch');
    expect(prompt).toContain('Mutation("create_entries"');
    expect(prompt).not.toContain('mock data');
  });
});
