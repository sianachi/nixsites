import type { NixClient } from '@nix/api-client';
import { nixSchema } from '@nix/editor-schema';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { snapshotMarkdown } from './markdown-mode';
import { MarkdownModePanel } from './markdown-mode-panel';

export default { title: 'Nix/Editor/Markdown mode', parameters: { layout: 'padded' } };

const noop = (): void => undefined;

const hit = (id: string, title: string) => ({
  id,
  workspaceId: 'w1',
  type: 'note',
  title,
  parentId: null,
  updatedAt: '2026-01-01T00:00:00Z',
});

/** A client whose item search answers from a fixed list, so the picker has something to show. */
const client = {
  query: () =>
    Promise.resolve({
      query: 'plan',
      results: [hit('a1', 'Alpha plan'), hit('b2', 'Budget plan')],
      limit: 25,
      truncated: false,
    }),
} as unknown as NixClient;

function Panel(): ReactElement {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  prosemirrorJSONToYXmlFragment(
    nixSchema,
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] },
    fragment,
  );
  return (
    <ApiClientOverrideProvider client={client}>
      <div className="flex h-96 flex-col">
        <MarkdownModePanel
          doc={doc}
          fragment={fragment}
          snapshot={snapshotMarkdown(fragment)}
          onClose={noop}
        />
      </div>
    </ApiClientOverrideProvider>
  );
}

export const Editing = { render: (): ReactElement => <Panel /> };

/** `[[plan` typed: the note-link list opens under the textarea, ready for the arrow keys. */
export const LinkPicker = {
  render: (): ReactElement => <Panel />,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole('textbox', { name: 'Note as Markdown' });
    await userEvent.clear(box);
    // user-event reads `[` as a key descriptor, so a literal `[` is typed as `[[`.
    await userEvent.type(box, '[[[[plan');
    await canvas.findByRole('option', { name: 'Alpha plan' });
  },
};

export const DarkLinkPicker = { ...LinkPicker, globals: { ground: 'dark' } };
