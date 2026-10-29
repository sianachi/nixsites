import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import { nixExtensions, nixSchema } from '@nix/editor-schema';
import { EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';
import { ItemBlockView, NoteSourcesProvider } from '../../editor/note-block-views';
import { ReferenceResolutionProvider } from '../../editor/reference-resolution';
import type { CollabSyncOptions } from '../../editor/collab-sync';
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
  startCollabSync: (options: CollabSyncOptions) => {
    harness.start(options);
    return { destroy: harness.destroy, flushAndWait: harness.flushAndWait };
  },
}));
const target = '00000000-0000-4000-8000-000000000099';
const embed = { type: 'itemBlock', attrs: { targetId: target, presentation: 'embed' } };
const extensions = nixExtensions.map((extension) =>
  extension.name === 'itemBlock'
    ? extension.extend({
        addNodeView() {
          return ReactNodeViewRenderer(ItemBlockView);
        },
      })
    : extension,
);
function Harness({
  twice = false,
  presentation = 'embed',
}: {
  readonly twice?: boolean;
  readonly presentation?: string;
}) {
  const section = { ...embed, attrs: { ...embed.attrs, presentation } };
  const editor = useEditor({
    extensions,
    onUpdate: harness.parentUpdate,
    content: { type: 'doc', content: twice ? [section, section] : [section] },
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
  harness.flushAndWait.mockResolvedValue(undefined);
  harness.query.mockResolvedValue({
    references: [
      {
        id: target,
        readable: true,
        item: { title: 'Source note', workspaceId: 'workspace', type: 'note' },
      },
    ],
  });
  harness.start.mockImplementation((options: CollabSyncOptions) => {
    const source = prosemirrorJSONToYDoc(
      nixSchema,
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Current source content' }] },
          embed,
        ],
      },
      'default',
    );
    Y.applyUpdate(options.doc, Y.encodeStateAsUpdate(source));
    source.destroy();
    options.onState('live');
    return { destroy: harness.destroy, flushAndWait: harness.flushAndWait };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('live note sections', () => {
  it('shares one subscription and renders nested embeds as links instead of recursing', async () => {
    render(<Harness twice />);
    await waitFor(() => {
      expect(screen.getAllByText('Current source content')).toHaveLength(2);
    });
    expect(harness.start).toHaveBeenCalledTimes(1);
    const user = userEvent.setup();
    const firstCollapse = screen.getAllByRole('button', { name: 'Collapse' })[0];
    if (firstCollapse === undefined) throw new Error('Missing collapse button');
    await user.click(firstCollapse);
    expect(harness.destroy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(harness.destroy).toHaveBeenCalledTimes(1);
  });
  it('clears displayed content and titles when the source connection loses access', async () => {
    render(<Harness />);
    await screen.findByText('Current source content');
    harness.query.mockResolvedValue({ references: [{ id: target, readable: false, item: null }] });
    const options = harness.start.mock.calls[0]?.[0] as CollabSyncOptions;
    act(() => {
      options.onState('offline');
      options.onNotice?.({ code: 'access_revoked', detail: 'Access revoked' });
    });
    await waitFor(() =>
      expect(screen.queryByText('Current source content')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByText('Source note')).not.toBeInTheDocument());
  });
});

it('updates an expanded section when the source document changes', async () => {
  render(<Harness />);
  await screen.findByText('Current source content');
  const options = harness.start.mock.calls[0]?.[0] as CollabSyncOptions;
  const paragraph = options.doc.getXmlFragment('default').get(0);
  if (!(paragraph instanceof Y.XmlElement)) throw new Error('No source paragraph');
  const text = paragraph.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error('No source text');
  act(() => {
    text.insert(text.length, ' updated');
  });
  await screen.findByText('Current source content updated');
});

it('expands subpages with live content and leaves the source intact when removed', async () => {
  render(<Harness presentation="subpage" />);
  await screen.findByText('Current source content');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open page' }));
  expect(harness.select).toHaveBeenCalledWith(target);
  await user.click(screen.getByRole('button', { name: 'Collapse' }));
  expect(screen.queryByText('Current source content')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Expand' }));
  await screen.findByText('Current source content');
  await user.click(screen.getByRole('button', { name: 'Remove embed' }));
  expect(screen.queryByText('Current source content')).not.toBeInTheDocument();
});

it('lets the user type directly into an empty source', async () => {
  harness.start.mockImplementation((options: CollabSyncOptions) => {
    options.onState('live');
  });
  render(<Harness />);
  const body = await screen.findByRole('textbox', { name: 'Embedded note content' });
  body.focus();
  await userEvent.setup().type(body, 'New source content', { skipClick: true });
  const options = harness.start.mock.calls[0]?.[0] as CollabSyncOptions;
  expect(JSON.stringify(options.doc.getXmlFragment('default').toJSON())).toContain(
    'New source content',
  );
});

it.each(['embed', 'subpage'])(
  'edits a %s source in place, synchronizes repeated sections, and isolates parent history',
  async (presentation) => {
    render(<Harness twice presentation={presentation} />);
    await screen.findAllByText('Current source content');
    const body = screen.getAllByRole('textbox', { name: 'Embedded note content' })[0];
    if (body === undefined) throw new Error('Missing editor');
    expect(body).toHaveAttribute('contenteditable', 'true');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    harness.parentUpdate.mockClear();
    const user = userEvent.setup();
    body.focus();
    await user.type(body, 'Added here', { skipClick: true });
    const options = harness.start.mock.calls[0]?.[0] as CollabSyncOptions;
    expect(JSON.stringify(options.doc.getXmlFragment('default').toJSON())).toContain('Added here');
    await waitFor(() => {
      expect(screen.getAllByText(/Added here/)).toHaveLength(2);
    });
    expect(harness.parentUpdate).not.toHaveBeenCalled();
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => {
      expect(JSON.stringify(options.doc.getXmlFragment('default').toJSON())).not.toContain(
        'Added here',
      );
    });
  },
);

it('honors the source permission independently of the parent editor', async () => {
  render(<Harness />);
  await screen.findByText('Current source content');
  const options = harness.start.mock.calls[0]?.[0] as CollabSyncOptions;
  act(() => {
    options.onState('readonly');
  });
  expect(screen.getByRole('textbox', { name: 'Embedded note content' })).toHaveAttribute(
    'contenteditable',
    'false',
  );
  expect(screen.getByText('Read-only source')).toBeInTheDocument();
});

it('keeps an editable source connected through StrictMode effect replay', async () => {
  render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  const body = await screen.findByRole('textbox', { name: 'Embedded note content' });
  body.focus();
  await userEvent.setup().type(body, 'Strict source edit', { skipClick: true });
  const options = harness.start.mock.calls.at(-1)?.[0] as CollabSyncOptions;
  expect(options.doc.isDestroyed).toBe(false);
  expect(JSON.stringify(options.doc.getXmlFragment('default').toJSON())).toContain(
    'Strict source edit',
  );
});

it('retains source edits through a temporary disconnection', async () => {
  render(<Harness />);
  const body = await screen.findByRole('textbox', { name: 'Embedded note content' });
  body.focus();
  await userEvent.setup().type(body, 'Retained edit', { skipClick: true });
  const options = harness.start.mock.calls[0]?.[0] as CollabSyncOptions;
  act(() => {
    options.onState('offline');
  });
  expect(options.doc.isDestroyed).toBe(false);
  expect(harness.destroy).not.toHaveBeenCalled();
  act(() => {
    options.onState('live');
  });
  await screen.findByText(/Retained edit/);
  expect(harness.start).toHaveBeenCalledTimes(1);
});

it('retains a collapsed offline draft until reconnecting confirms persistence', async () => {
  render(<Harness />);
  const body = await screen.findByRole('textbox', { name: 'Embedded note content' });
  body.focus();
  const user = userEvent.setup();
  await user.type(body, 'Unsent source edit', { skipClick: true });
  const options = harness.start.mock.calls[0]?.[0] as CollabSyncOptions;
  act(() => {
    options.onState('offline');
  });
  await user.click(screen.getByRole('button', { name: 'Collapse' }));
  expect(options.doc.isDestroyed).toBe(false);
  expect(harness.flushAndWait).not.toHaveBeenCalled();
  let saved = (): void => undefined;
  harness.flushAndWait.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  await act(async () => {
    options.onState('live');
    await Promise.resolve();
  });
  expect(harness.flushAndWait).toHaveBeenCalledTimes(1);
  expect(options.doc.isDestroyed).toBe(false);
  expect(JSON.stringify(options.doc.getXmlFragment('default').toJSON())).toContain(
    'Unsent source edit',
  );
  await act(async () => {
    saved();
    await Promise.resolve();
  });
  expect(options.doc.isDestroyed).toBe(true);
  expect(harness.destroy).toHaveBeenCalledTimes(1);
});

it('retains an offline draft when metadata refresh temporarily hides the source', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  render(<Harness />);
  const body = await screen.findByRole('textbox', { name: 'Embedded note content' });
  body.focus();
  await userEvent.setup().type(body, 'Metadata outage draft', { skipClick: true });
  const options = harness.start.mock.calls[0]?.[0] as CollabSyncOptions;
  act(() => {
    options.onState('offline');
  });
  harness.query
    .mockRejectedValueOnce(new Error('Offline'))
    .mockImplementation(() => new Promise(() => undefined));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await act(async () => {
    const refresh = intervals.mock.calls.find((call) => call[1] === 30_000)?.[0];
    if (typeof refresh !== 'function') throw new Error('No metadata refresh timer');
    refresh();
    await Promise.resolve();
  });
  expect(screen.getByText('Linked item unavailable')).toBeInTheDocument();
  expect(options.doc.isDestroyed).toBe(false);
  expect(harness.destroy).not.toHaveBeenCalled();
  await act(async () => {
    options.onState('live');
    await Promise.resolve();
  });
  expect(harness.flushAndWait).toHaveBeenCalledTimes(1);
  expect(options.doc.isDestroyed).toBe(true);
  warning.mockRestore();
  intervals.mockRestore();
});
