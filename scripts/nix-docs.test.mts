import assert from 'node:assert/strict';
import test from 'node:test';

import { originalSource, renderBundle, run } from './nix-docs.mts';

const bundle = (content: unknown[]) =>
  ({ body: { prosemirror: { type: 'doc', content } } }) as never;

test('renders lists, links and fenced code like the Go reader', () => {
  const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });
  const out = renderBundle(
    bundle([
      { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [text('see', [{ type: 'link', attrs: { href: 'nix://item/abc' } }])],
              },
            ],
          },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('a\nb')] },
    ]),
  );
  assert.equal(out, '## Title\n\n- see (nix://item/abc)\n\n\n```ts\na\nb\n```\n');
});

test('source must be one verbatim code block', () => {
  const code = { type: 'codeBlock', content: [{ type: 'text', text: 'x\r\n' }] };
  assert.equal(originalSource(bundle([code])), 'x\r\n');
  assert.throws(() => originalSource(bundle([code, code])), /one verbatim code block/);
});

test('check verifies the committed archives', async () => {
  assert.match(await run(['check']), /^Verified \d+ native archives/);
});
