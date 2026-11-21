import { renderHook } from '@testing-library/react';
import type * as Fence from '../../openui/fence';
import { describe, expect, it, vi } from 'vitest';
import * as fence from '../../openui/fence';
import { useStablePieces } from '../../pets/conversation/state/use-stable-pieces';

vi.mock('../../openui/fence', async (importOriginal) => {
  const actual = await importOriginal<typeof Fence>();
  return { ...actual, programPieces: vi.fn(actual.programPieces) };
});

const block = (source: string, info = 'openui-lang') => `\`\`\`${info}\n${source}\n\`\`\``;

function conversation(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: index % 2 === 0 ? `Question ${String(index)}` : block(`root = Text("${String(index)}")`),
  }));
}

describe('useStablePieces', () => {
  it('reparses only the changed tail and matches earlierPieces', () => {
    const base = conversation(40);
    const draft = (text: string) => ({ role: 'assistant', text });
    const { result, rerender } = renderHook(({ list }) => useStablePieces(list), {
      initialProps: { list: [...base, draft('a')] },
    });
    const parse = vi.mocked(fence.programPieces);
    expect(parse).toHaveBeenCalledTimes(21);

    parse.mockClear();
    const first = result.current;
    for (const text of ['ab', 'abc', 'abcd']) {
      const list = [...base.map((m) => ({ ...m })), draft(text)];
      rerender({ list });
      expect(result.current).toEqual(fence.earlierPieces(list));
    }
    expect(parse).toHaveBeenCalledTimes(3);
    expect(result.current[20]).toBe(first[20]);

    // An edit in the middle reparses from there; a patch fence and a branch switch stay equal.
    const edited = [...base];
    edited[11] = { role: 'assistant', text: block('root = Text("x")') };
    edited[13] = { role: 'assistant', text: block('root = Text("y")', 'openui-lang patch') };
    parse.mockClear();
    rerender({ list: edited });
    expect(result.current).toEqual(fence.earlierPieces(edited));
    expect(parse).toHaveBeenCalledTimes(15);
    const branch = conversation(5);
    rerender({ list: branch });
    expect(result.current).toEqual(fence.earlierPieces(branch));
  });
});
