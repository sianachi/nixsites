import { expect, it, vi } from 'vitest';

const renderer = vi.hoisted(() => ({
  loaded: vi.fn(),
  initialize: vi.fn(),
  render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
}));

vi.mock('mermaid', () => {
  renderer.loaded();
  return { default: renderer };
});

it('loads Mermaid only when a diagram is requested', async () => {
  const { renderMermaid } = await import('../../plugins/mermaid-render');
  expect(renderer.loaded).not.toHaveBeenCalled();
  expect(await renderMermaid('graph TD; A-->B', 'lazy-diagram')).toBe('<svg></svg>');
  expect(renderer.loaded).toHaveBeenCalledOnce();
  expect(renderer.initialize).toHaveBeenCalledOnce();
});
