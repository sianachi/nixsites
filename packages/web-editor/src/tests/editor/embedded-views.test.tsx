import 'fake-indexeddb/auto';
import { nixExtensions } from '@nix/editor-schema';
import { EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideEmbeddedViews } from '../../editor/embedded-views-slot';
import { ItemBlockView, NoteSourcesProvider } from '../../editor/note-block-views';
import { ReferenceResolutionProvider } from '../../editor/reference-resolution';
const harness = vi.hoisted(() => ({
  query: vi.fn(),
  start: vi.fn(),
  destroy: vi.fn(),
  flushAndWait: vi.fn(),
  select: vi.fn(),
  parentUpdate: vi.fn(),
}));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => harness }));
vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve('token') }),
}));
vi.mock('@nix/web-platform/routing/selected-item', () => ({ useSelectedItem: () => harness }));
vi.mock('../../editor/collab-sync', () => ({
  FRAGMENT_NAME: 'default',
  startCollabSync: () => ({ destroy: vi.fn(), flushAndWait: vi.fn() }),
}));
const target = '00000000-0000-4000-8000-000000000099';
const extensions = nixExtensions.map((extension) =>
  extension.name === 'itemBlock'
    ? extension.extend({
        addNodeView() {
          return ReactNodeViewRenderer(ItemBlockView);
        },
      })
    : extension,
);

// The app's views, reduced to the contract: it is told the remembered view and reports a choice.
provideEmbeddedViews(({ viewId, onViewChange, document }) => (
  <div>
    <p>Showing {viewId ?? 'default'}</p>
    <button
      onClick={() => {
        onViewChange('board');
      }}
    >
      Pick board
    </button>
    {document}
  </div>
));

function Harness({
  view = null,
  editable = true,
}: {
  readonly view?: string | null;
  readonly editable?: boolean;
}) {
  const editor = useEditor({
    extensions,
    editable,
    onUpdate: harness.parentUpdate,
    content: {
      type: 'doc',
      content: [{ type: 'itemBlock', attrs: { targetId: target, presentation: 'embed', view } }],
    },
  });
  return (
    <NoteSourcesProvider>
      <ReferenceResolutionProvider>
        <EditorContent editor={editor} />
      </ReferenceResolutionProvider>
    </NoteSourcesProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.query.mockResolvedValue({
    references: [
      {
        id: target,
        readable: true,
        item: { title: 'Source note', workspaceId: 'workspace', type: 'note' },
      },
    ],
  });
});
afterEach(cleanup);

describe('an embedded note with views', () => {
  it('shows the remembered view and writes a new choice to the node', async () => {
    const { unmount } = render(<Harness />);
    expect(await screen.findByText('Showing default')).toBeVisible();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Pick board' }));
    const updated = harness.parentUpdate.mock.calls.at(-1)?.[0] as {
      editor: { getJSON: () => { content: { attrs: { view: string } }[] } };
    };
    expect(updated.editor.getJSON().content[0]?.attrs.view).toBe('board');
    unmount();

    // Remounted from the written node, not a hand-set prop.
    render(<Harness view={updated.editor.getJSON().content[0]?.attrs.view ?? null} />);
    expect(await screen.findByText('Showing board')).toBeVisible();
  });

  it("keeps a read-only host's choice local, off the node", async () => {
    render(<Harness editable={false} />);
    expect(await screen.findByText('Showing default')).toBeVisible();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Pick board' }));
    expect(await screen.findByText('Showing board')).toBeVisible();
    expect(harness.parentUpdate).not.toHaveBeenCalled();
  });
});
