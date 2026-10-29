import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import type * as apiClient from '@nix/api-client';
import type * as collabSync from '../../editor/collab-sync';
import type * as apiClientProvider from '@nix/web-platform/api/api-client-provider';
import { useKeyboardModeStore } from '../../editor/keyboard-mode-store';
import { useWritingModePreference } from '../../editor/writing-mode';
import { useTextWidthPreference } from '../../editor/text-width-preference';
import { NoteEditor } from '../../editor/note-editor';
import type * as reactRouter from 'react-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

/**
 * The provider is replaced, and the document it is handed is kept.
 *
 * `NoteEditor` builds its own `Y.Doc` with `useState`, so there is no way in from outside - and
 * that document is the whole subject. `startCollabSync` is the one place it is passed anywhere,
 * which makes the provider the natural seam: stub it, keep what it was given, and the test can ask
 * the real component's real document what is in it.
 */
let captured: Y.Doc | null = null;
let syncOptions: Parameters<typeof collabSync.startCollabSync>[0] | null = null;

const NAVIGATOR_PLATFORM: unknown = Reflect.get(navigator, 'platform');
const MODIFIER: KeyboardEventInit =
  typeof NAVIGATOR_PLATFORM === 'string' && /Mac|iP(hone|[oa]d)/.test(NAVIGATOR_PLATFORM)
    ? { metaKey: true }
    : { ctrlKey: true };

const fileHarness = vi.hoisted(() => ({
  beginUpload: vi.fn((input: unknown) => ({ operation: 'files.upload.begin', body: input })),
  uploadAndCompleteFile: vi.fn(),
  deleteItem: vi.fn((workspaceId: string, itemId: string) => ({
    operation: 'items.delete',
    workspaceId,
    itemId,
  })),
  fetchFileContent: vi.fn(() => Promise.reject(new Error('Preview unavailable in this test'))),
  client: {
    execute: vi.fn(() => Promise.resolve({ id: 'upload-id' })),
    query: vi.fn(() => Promise.resolve({ references: [] })),
  },
}));

function pluginKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('key' in value)) {
    return null;
  }
  return typeof value.key === 'string' ? value.key : null;
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const result: unknown = Reflect.get(value, key);
  return result;
}

vi.mock('../../editor/collab-sync', async () => {
  const actual = await vi.importActual<typeof collabSync>('../../editor/collab-sync');
  return {
    ...actual,
    startCollabSync: (options: Parameters<typeof collabSync.startCollabSync>[0]) => {
      captured = options.doc;
      syncOptions = options;
      return { awareness: null, destroy: () => undefined };
    },
  };
});

// BubbleMenu has its own real-editor suite. Its only extra work here would be measuring a text
// selection through `coordsAtPos`, a browser-layout API jsdom cannot implement.
vi.mock('../../editor/bubble-menu', () => ({ BubbleMenu: () => null }));

// Reference navigation has its own suite and requires a Router. This file inspects the reference
// node in Yjs, so rendering its routing control would add no coverage here.
vi.mock('@nix/web-platform/routing/selected-item', () => ({
  useSelectedItem: () => ({ select: vi.fn() }),
}));

vi.mock('../../editor/reference-view', () => ({ ReferenceView: () => null }));

vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve('token') }),
}));

vi.mock('@nix/api-client', async () => {
  const actual = await vi.importActual<typeof apiClient>('@nix/api-client');
  return {
    ...actual,
    files: {
      ...actual.files,
      beginUpload: fileHarness.beginUpload,
      uploadAndCompleteFile: fileHarness.uploadAndCompleteFile,
      fetchFileContent: fileHarness.fetchFileContent,
    },
    items: { ...actual.items, deleteItem: fileHarness.deleteItem },
  };
});

vi.mock('@nix/web-platform/api/api-client-provider', async () => {
  const actual = await vi.importActual<typeof apiClientProvider>(
    '@nix/web-platform/api/api-client-provider',
  );
  return { ...actual, useApiClient: () => fileHarness.client };
});

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof reactRouter>('react-router');
  return {
    ...actual,
    useParams: () => ({ workspaceId: '00000000-0000-4000-8000-000000000002' }),
  };
});

/**
 * The one thing about this editor that cannot be inspected by looking at it: whether what somebody
 * types reaches the shared document.
 *
 * This exists because it did not, for a new note, for as long as the collaborative editor has. The
 * Yjs plugins were added with `registerPlugin` inside `onCreate` - after the editor already
 * existed - and a binding established that late never carried ProseMirror's content into Yjs. An
 * *existing* note hid it completely: the server's own state arrives and drives Yjs to ProseMirror,
 * so the binding looks alive in the direction anybody would check. A new one had nothing to
 * receive, so its fragment stayed empty, every update the client sent merged to an empty document,
 * and the collaboration service refused all of them with `document_does_not_parse` while
 * `head_seq` sat at zero.
 *
 * Nothing about that is visible in the interface. The text stays on screen, the footer says live,
 * and the work is gone on reload.
 */

beforeEach(() => {
  captured = null;
  syncOptions = null;
  fileHarness.beginUpload.mockClear();
  fileHarness.uploadAndCompleteFile.mockReset();
  fileHarness.deleteItem.mockClear();
  fileHarness.client.execute.mockClear();
  useKeyboardModeStore.setState({ mode: 'standard', persistence: 'stored' });
  useWritingModePreference.setState({ mode: 'prose', saved: true });
  useTextWidthPreference.setState({ width: 'reading', saved: true });
});

/** Renders the editor and returns the shared document it handed the provider. */
async function open(): Promise<Y.Doc> {
  render(
    <ApiClientProvider>
      <NoteEditor itemId="00000000-0000-4000-8000-000000000001" />
    </ApiClientProvider>,
  );

  await waitFor(() => {
    expect(captured).not.toBeNull();
  });

  const doc = captured;
  if (doc === null) {
    throw new Error('The editor never handed its document to the provider.');
  }
  return doc;
}

it('changes writing modes while retaining the collaborative body and its connection', async () => {
  const document = await open();
  const body = screen.getByRole('textbox', { name: 'Note body' });
  body.focus();
  await userEvent.type(body, 'My plan', { skipClick: true });
  await userEvent.click(screen.getByRole('button', { name: 'Writing mode: Prose' }));
  await userEvent.click(screen.getByRole('button', { name: /^Planning/ }));

  await waitFor(() => {
    expect(body).toHaveAttribute('data-writing-mode', 'planning');
  });
  expect(screen.getByRole('textbox', { name: 'Note body' })).toBe(body);
  expect(captured).toBe(document);
  expect(body).toHaveTextContent('My plan');
  expect(screen.getByRole('button', { name: 'Task list' })).toBeInTheDocument();
});

it('changes text width without replacing the editor or its collaborative document', async () => {
  const document = await open();
  const body = screen.getByRole('textbox', { name: 'Note body' });
  body.focus();
  await userEvent.type(body, 'Keep this work', { skipClick: true });
  await userEvent.click(screen.getByRole('button', { name: 'Text width' }));
  await userEvent.click(screen.getByRole('button', { name: 'Full pane width' }));
  expect(body.closest('[data-text-width]')).toHaveAttribute('data-text-width', 'full');
  expect(body.closest('[data-text-width]')).toHaveClass('[&_.ProseMirror]:max-w-none');
  expect(screen.getByRole('textbox', { name: 'Note body' })).toBe(body);
  expect(captured).toBe(document);
  expect(body).toHaveTextContent('Keep this work');
  await userEvent.click(screen.getByRole('button', { name: 'Text width' }));
  await userEvent.click(screen.getByRole('button', { name: 'Reading width' }));
  expect(body.closest('[data-text-width]')).toHaveAttribute('data-text-width', 'reading');
  expect(body.closest('[data-text-width]')).toHaveClass('max-w-prose');
});

it('keeps the phone writing surface readable when full pane width was selected on desktop', async () => {
  stubViewport(false);
  useTextWidthPreference.setState({ width: 'full' });
  await open();
  const body = screen.getByRole('textbox', { name: 'Note body' });
  expect(body.closest('[data-text-width]')).toHaveAttribute('data-text-width', 'reading');
  expect(screen.queryByRole('button', { name: 'Text width' })).not.toBeInTheDocument();
  expect(useTextWidthPreference.getState().width).toBe('full');
});

it.each(['body_access_unavailable', 'access_revoked'])(
  'hides the mounted body after %s while retaining the pending document for recovery',
  async (code) => {
    const document = await open();
    const body = screen.getByRole('textbox', { name: 'Note body' });
    body.focus();
    await userEvent.type(body, 'Private pending plan', { skipClick: true });
    const sync = syncOptions;
    if (!sync) throw new Error('The editor must start document sync');
    act(() => {
      sync.onNotice?.({ code, detail: 'Access is unavailable.' });
    });
    expect(screen.queryByRole('textbox', { name: 'Note body' })).not.toBeInTheDocument();
    expect(screen.queryByText('Private pending plan')).not.toBeInTheDocument();
    expect(document.getXmlFragment('default').toJSON()).toContain('Private pending plan');
  },
);

it('reports sync and save failures in one dialog without a footer or warning banners', async () => {
  await open();
  const sync = syncOptions;
  if (!sync) throw new Error('The editor must start document sync');
  act(() => {
    sync.onState('degraded');
    sync.onNotice?.({ code: 'document_too_large', detail: '' });
  });
  const dialog = screen.getByRole('dialog', { name: 'Document needs attention' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(dialog).toHaveTextContent('size limit');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(document.querySelector('footer')).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
  act(() => {
    sync.onState('connecting');
  });
  act(() => {
    sync.onState('pending');
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('stops read-only notes accepting edits and explains that pre-connection edits were not saved', async () => {
  await open();
  const sync = syncOptions;
  if (!sync) throw new Error('The editor must start document sync');
  act(() => {
    sync.onState('readonly');
  });
  expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveAttribute(
    'contenteditable',
    'false',
  );
  expect(screen.getByRole('dialog')).toHaveTextContent('edits cannot be saved');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('toolbar', { name: 'Formatting' })).not.toBeInTheDocument();
  act(() => {
    sync.onState('connecting');
  });
  expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveAttribute(
    'contenteditable',
    'false',
  );
  expect(screen.queryByRole('toolbar', { name: 'Formatting' })).not.toBeInTheDocument();
  act(() => {
    sync.onState('live');
  });
  expect(screen.getByRole('textbox', { name: 'Note body' })).toHaveAttribute(
    'contenteditable',
    'true',
  );
  expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
});

vi.stubGlobal(
  'URL',
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test-image'), revokeObjectURL: vi.fn() }),
);

describe('a note nobody has typed into yet', () => {
  it('puts a change made through the interface into the shared document', async () => {
    // **The regression, stated exactly.** With the Yjs binding supplied at construction, an edit
    // reaches the shared fragment. With the plugins registered afterwards in `onCreate` - which is
    // where they lived - it never did: the fragment stayed empty for the life of the note, every
    // update the client sent merged to a document with no blocks in it, and the collaboration
    // service refused all of them with `document_does_not_parse` while `head_seq` sat at zero.
    //
    // Nothing about that is visible in the interface. The text stays on screen, the footer says
    // live, and the work is gone on reload.
    //
    // Driven through a toolbar button rather than by typing: it is a real transaction on the real
    // editor, and it does not depend on ProseMirror's key handling under jsdom.
    const user = userEvent.setup();
    const doc = await open();

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));

    await waitFor(() => {
      expect(doc.getXmlFragment('default').toArray().length).toBeGreaterThan(0);
    });
  });

  it('puts a block there, which is what the schema requires', async () => {
    // `doc` is `block+`. A fragment holding nothing converts to a document with no content, and
    // that is the shape the service refuses - so "not empty" is the claim and "holds a block" is
    // why it matters.
    const user = userEvent.setup();
    const doc = await open();

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));

    await waitFor(() => {
      // `toJSON` rather than `toString`: an XmlFragment's default stringification is the object
      // tag, which would make this assertion pass on anything at all.
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain('heading');
    });
  });

  it('emits an update for a peer to receive', async () => {
    // No update means nothing is sent, however healthy the local editor looks.
    const user = userEvent.setup();
    const doc = await open();

    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));

    await waitFor(() => {
      expect(updates).toBeGreaterThan(0);
    });
  });

  it('inserts an accessible image through the shared form', async () => {
    const user = userEvent.setup();
    const doc = await open();

    // Give the image a real insertion point. The collaboration fragment starts empty in this
    // harness until the first local transaction; production notes open with a schema-valid block.
    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.click(screen.getByRole('button', { name: 'Image URL' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Image address' }),
      'https://images.example.test/roadmap.png',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Description' }),
      'Product roadmap drawn as a timeline',
    );
    await user.click(screen.getByRole('button', { name: 'Insert image' }));

    await waitFor(() => {
      const body = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(body).toContain('https://images.example.test/roadmap.png');
      expect(body).toContain('Product roadmap drawn as a timeline');
      expect(body.match(/https:\/\/images\.example\.test\/roadmap\.png/g)).toHaveLength(1);
      expect(body).toContain('paragraph');
    });
    expect(screen.queryByRole('dialog', { name: 'Insert image' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Note body')).toHaveFocus();
    });
  });

  it('keeps an actionable image upload failure inside the existing form without a second dialog', async () => {
    const user = userEvent.setup();
    await open();
    fileHarness.uploadAndCompleteFile.mockRejectedValue(
      new Error('Workspace storage quota exceeded.'),
    );
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.upload(
      screen.getByLabelText('Choose image to upload'),
      new File(['image'], 'diagram.png', { type: 'image/png' }),
    );
    await user.click(screen.getByRole('button', { name: 'Insert image' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace storage quota exceeded.');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(
      screen.queryByRole('dialog', { name: 'Document needs attention' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uploads a selected image into the shared note and leaves a paragraph to continue writing', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const fileItemId = '00000000-0000-4000-8000-000000000099';
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    fileHarness.uploadAndCompleteFile.mockResolvedValue({
      itemId: fileItemId,
      current: { previewable: true },
    });
    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.upload(screen.getByLabelText('Choose image to upload'), file);
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'A diagram');
    await user.click(screen.getByRole('button', { name: 'Insert image' }));

    await waitFor(() => {
      const blocks = doc.getXmlFragment('default').toArray();
      const image = blocks.find(
        (block) => block instanceof Y.XmlElement && block.nodeName === 'image',
      );
      expect(image).toBeInstanceOf(Y.XmlElement);
      if (!(image instanceof Y.XmlElement)) throw new Error('The image was not inserted.');
      expect(image.getAttribute('fileItemId')).toBe(fileItemId);
      expect(image.getAttribute('alt')).toBe('A diagram');
      expect(
        blocks.some((block) => block instanceof Y.XmlElement && block.nodeName === 'paragraph'),
      ).toBe(true);
    });
    expect(fileHarness.beginUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: '00000000-0000-4000-8000-000000000002',
        parentId: '00000000-0000-4000-8000-000000000001',
        fileName: 'diagram.png',
      }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Note body')).toHaveFocus());
  });

  it('inserts an attachment when an uploaded image cannot be previewed', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const fileItemId = '00000000-0000-4000-8000-000000000099';
    fileHarness.uploadAndCompleteFile.mockResolvedValue({
      itemId: fileItemId,
      current: { previewable: false },
    });
    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.upload(
      screen.getByLabelText('Choose image to upload'),
      new File(['opaque'], 'image.png', { type: 'image/png' }),
    );
    await user.click(screen.getByRole('button', { name: 'Insert image' }));
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain(fileItemId);
    });
    expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain('itemblock');
    expect(fileHarness.deleteItem).not.toHaveBeenCalled();
  });

  it('discards a completed upload when the editor unmounts before image insertion', async () => {
    const user = userEvent.setup();
    await open();
    const fileItemId = '00000000-0000-4000-8000-000000000099';
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    let resolveUpload: ((value: unknown) => void) | undefined;
    fileHarness.uploadAndCompleteFile.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.upload(screen.getByLabelText('Choose image to upload'), file);
    await user.click(screen.getByRole('button', { name: 'Insert image' }));
    cleanup();

    if (resolveUpload === undefined) throw new Error('The upload did not start.');
    resolveUpload({ itemId: fileItemId, current: { previewable: true } });

    await waitFor(() => {
      expect(fileHarness.deleteItem).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000002',
        fileItemId,
      );
    });
  });

  it('inserts a file reference when inspection refuses a dropped image preview', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const fileItemId = '00000000-0000-4000-8000-000000000099';
    fileHarness.uploadAndCompleteFile.mockResolvedValue({
      itemId: fileItemId,
      current: { previewable: false },
    });

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    fireEvent.drop(screen.getByLabelText('Note body'), {
      clientX: 0,
      clientY: 0,
      dataTransfer: {
        files: [new File(['not really a png'], 'diagram.png', { type: 'image/png' })],
        types: ['Files'],
      },
    });

    await waitFor(() => {
      expect(fileHarness.uploadAndCompleteFile).toHaveBeenCalledOnce();
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).toContain(fileItemId);
      expect(shared).toContain('itemblock');
      expect(shared).not.toContain('fileItemId');
    });
  });

  it('commits a submitted image before the deferred focus frame can be interrupted', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    const doc = await open();

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.click(screen.getByRole('button', { name: 'Image URL' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Image address' }),
      'https://images.example.test/committed-before-focus.png',
    );
    await user.click(screen.getByRole('button', { name: 'Insert image' }));

    // The frame is deliberately never run. A tab change can unmount the editor at this exact
    // point, so a command queued beside focus would lose an already accepted submission.
    expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain(
      'https://images.example.test/committed-before-focus.png',
    );
    expect(screen.queryByRole('dialog', { name: 'Insert image' })).not.toBeInTheDocument();
  });

  it('leaves the document untouched and restores the Insert trigger when insertion is cancelled', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const insertTrigger = screen.getByRole('button', { name: 'Insert' });
    await user.click(insertTrigger);
    const imageButton = screen.getByRole('button', { name: 'Image' });
    const before = JSON.stringify(doc.getXmlFragment('default').toJSON());

    await user.click(imageButton);
    await user.click(screen.getByRole('button', { name: 'Image URL' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Image address' }),
      'https://images.example.test/unused.png',
    );
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(screen.queryByRole('dialog', { name: 'Insert image' })).not.toBeInTheDocument();
    expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toBe(before);
    expect(insertTrigger).toHaveFocus();
  });

  it('keeps a selected link anchored while a peer edits and writes the mark to the shared document', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const body = screen.getByLabelText('Note body');

    doc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Roadmap')]);
      doc.getXmlFragment('default').push([paragraph]);
    });
    await waitFor(() => {
      expect(body).toHaveTextContent('Roadmap');
    });
    body.focus();
    const text = body.querySelector('p')?.firstChild;
    if (text === null || text === undefined) {
      throw new Error('The shared paragraph did not render a text node.');
    }
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'Roadmap'.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await user.click(screen.getByRole('button', { name: 'Add link' }));

    // The modal preserves an editor selection while collaboration continues behind it. A peer
    // appending a block exercises the Yjs mapping boundary before the delayed command consumes
    // that selection; the link must stay on the local text rather than disappear or move.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const beforePeerEdit = Y.encodeStateVector(doc);
    peer.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Peer note')]);
      peer.getXmlFragment('default').push([paragraph]);
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, beforePeerEdit));

    await user.type(
      screen.getByRole('textbox', { name: 'Link address' }),
      'https://example.test/roadmap',
    );
    await user.click(
      within(screen.getByRole('dialog', { name: 'Add link' })).getByRole('button', {
        name: 'Add link',
      }),
    );

    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).toContain('Roadmap');
      expect(shared).toContain('Peer note');
      expect(shared).toContain('https://example.test/roadmap');
      expect(shared.match(/https:\/\/example\.test\/roadmap/g)).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog', { name: 'Add link' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(body).toHaveFocus();
    });
    peer.destroy();
  });
});

describe('collaborative history keys', () => {
  it.each([
    ['undo', 'z', false],
    ['shift redo', 'z', true],
    ['alternate redo', 'y', false],
  ])(
    'claims empty %s instead of falling through to browser contenteditable history',
    async (_name, key, shiftKey) => {
      await open();
      const body = screen.getByLabelText('Note body');
      const event = new KeyboardEvent('keydown', {
        key,
        ...MODIFIER,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });

      body.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    },
  );

  it('installs only collaborative history', async () => {
    await open();
    const body = screen.getByLabelText('Note body');
    const editor: unknown = Reflect.get(body, 'editor');
    const extensions = property(property(editor, 'extensionManager'), 'extensions');
    const plugins = property(property(editor, 'state'), 'plugins');
    if (!Array.isArray(extensions) || !Array.isArray(plugins)) {
      throw new Error('TipTap did not expose its editor state on the ProseMirror element.');
    }

    expect(extensions.some((extension) => property(extension, 'name') === 'undoRedo')).toBe(false);
    expect(plugins.some((plugin) => pluginKey(plugin)?.startsWith('history$') === true)).toBe(
      false,
    );
  });

  it('returns focus to the note after toolbar undo', async () => {
    const user = userEvent.setup();
    await open();
    const body = screen.getByLabelText('Note body');
    const undoButton = screen.getByRole('button', { name: 'Undo' });

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await user.click(undoButton);

    await waitFor(() => {
      expect(body).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => {
      expect(body).toHaveFocus();
      expect(body.querySelector('h1')).not.toBeNull();
    });
  });

  it('keeps focus on an unavailable history action', async () => {
    const user = userEvent.setup();
    await open();
    const undoButton = screen.getByRole('button', { name: 'Undo' });

    await user.click(undoButton);

    expect(undoButton).toHaveFocus();
  });

  it('keeps redo available when a peer edits after this writer undoes', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const body = screen.getByLabelText('Note body');

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain('heading');
    });

    useKeyboardModeStore.setState({ mode: 'emacs' });
    body.focus();
    fireEvent.keyDown(body, { key: '/', ctrlKey: true });
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).not.toContain('heading');
    });

    // The remote transaction deliberately lands between undo and redo. It must neither enter this
    // client's history nor clear the redo stack that belongs to the local heading change.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const beforePeerEdit = Y.encodeStateVector(peer);
    peer.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      peer.getXmlFragment('default').push([paragraph]);
      const text = new Y.XmlText();
      paragraph.push([text]);
      text.insert(0, 'Peer note');
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, beforePeerEdit));

    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).not.toContain('heading');
      expect(shared).toContain('Peer note');
    });

    fireEvent.keyDown(body, { key: 'z', ...MODIFIER, shiftKey: true });
    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).toContain('heading');
      expect(shared).toContain('Peer note');
    });

    fireEvent.keyDown(body, { key: '_', ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).not.toContain('heading');
      expect(shared).toContain('Peer note');
    });
    // Emacs basics owns Ctrl+Y (yank) on Windows and Linux, so the alternate redo chord is
    // checked with the preset off.
    useKeyboardModeStore.setState({ mode: 'standard' });
    fireEvent.keyDown(body, { key: 'y', ...MODIFIER });
    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).toContain('heading');
      expect(shared).toContain('Peer note');
    });
    peer.destroy();
  });

  it('clears redo when this writer makes a new change after undo', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const body = screen.getByLabelText('Note body');

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    body.focus();
    fireEvent.keyDown(body, { key: 'z', ...MODIFIER });
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).not.toContain('heading');
    });

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 2' }));
    await waitFor(() => {
      expect(body.querySelector('h2')).not.toBeNull();
    });

    fireEvent.keyDown(body, { key: 'z', ...MODIFIER, shiftKey: true });
    expect(body.querySelector('h2')).not.toBeNull();
    expect(body.querySelector('h1')).toBeNull();
  });
});

describe('Vim basics in a note', () => {
  it('shows and announces the pane-local mode while describing how to leave it', async () => {
    useKeyboardModeStore.setState({ mode: 'vim' });
    await open();
    const body = screen.getByLabelText('Note body');
    const descriptionId = body.getAttribute('aria-describedby');

    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId ?? '')).toHaveTextContent(/Press i.*Escape/i);
    expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);

    fireEvent.keyDown(body, { key: 'i' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim insert/i);
    });
    fireEvent.keyDown(body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);
    });
  });

  it('switches the same collaborative editor live and resets each Vim session to Normal', async () => {
    await open();
    const body = screen.getByLabelText('Note body');
    const editor: unknown = Reflect.get(body, 'editor');

    act(() => {
      useKeyboardModeStore.setState({ mode: 'vim' });
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);
    });
    fireEvent.keyDown(body, { key: 'i' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim insert/i);
    });

    act(() => {
      useKeyboardModeStore.setState({ mode: 'standard' });
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => {
      useKeyboardModeStore.setState({ mode: 'vim' });
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);
    });

    expect(screen.getByLabelText('Note body')).toBe(body);
    expect(Reflect.get(body, 'editor')).toBe(editor);
  });

  it('keeps Normal inert and records Insert typing in local collaborative history', async () => {
    const user = userEvent.setup();
    useKeyboardModeStore.setState({ mode: 'vim' });
    const doc = await open();
    const body = screen.getByLabelText('Note body');
    body.focus();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);
    });
    const beforeNormal = JSON.stringify(doc.getXmlFragment('default').toJSON());

    fireEvent.keyDown(body, { key: 'Z' });
    body.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: 'blocked',
        bubbles: true,
        cancelable: true,
      }),
    );
    fireEvent.paste(body, {
      clipboardData: { getData: () => 'blocked', types: ['text/plain'] },
    });
    expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toBe(beforeNormal);

    fireEvent.keyDown(body, { key: 'i' });
    await user.keyboard('x');
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain('x');
    });
    fireEvent.keyDown(body, { key: 'Escape' });

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const beforePeerEdit = Y.encodeStateVector(doc);
    peer.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Peer note')]);
      peer.getXmlFragment('default').push([paragraph]);
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, beforePeerEdit));

    fireEvent.keyDown(body, { key: 'z', ...MODIFIER });
    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).not.toContain('x');
      expect(shared).toContain('Peer note');
    });
    peer.destroy();
  });

  it('lets an open slash menu consume Escape before Vim leaves Insert', async () => {
    const user = userEvent.setup();
    useKeyboardModeStore.setState({ mode: 'vim' });
    await open();
    const body = screen.getByLabelText('Note body');
    body.focus();
    fireEvent.keyDown(body, { key: 'i' });

    await user.keyboard('/');
    expect(await screen.findByRole('listbox')).toBeVisible();
    fireEvent.keyDown(body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/Vim insert/i);
    });
  });
});

describe('the block drag handle', () => {
  // What jsdom can express ends at "the handle is wired in": the drag-handle plugin appends its
  // element into the editor's DOM when it registers, so the element's presence is the proof of
  // registration. Actually dragging a block needs real layout and HTML5 drag events, neither of
  // which jsdom implements - that behavior is exercised only in a real browser.

  /** Renders the editor and returns the handle element from within this render's own tree. */
  async function openWithHandle(): Promise<HTMLElement> {
    const { container } = render(
      <ApiClientProvider>
        <NoteEditor itemId="00000000-0000-4000-8000-000000000001" />
      </ApiClientProvider>,
    );

    // `data-dragging` is set by the drag-handle plugin's own view setup, so finding it means the
    // plugin registered against this editor - not merely that some div rendered. Scoped to the
    // container so the assertion cannot be satisfied by anything outside this render.
    await waitFor(() => {
      expect(container.querySelector('[data-dragging]')).not.toBeNull();
    });
    const handle = container.querySelector<HTMLElement>('[data-dragging]');
    if (handle === null) {
      throw new Error('The drag-handle element never mounted.');
    }
    return handle;
  }

  it('mounts the handle element when the editor opens', async () => {
    await openWithHandle();
  });

  it('renders the grip glyph inside the handle, out of the accessibility tree', async () => {
    const handle = await openWithHandle();

    // The load-bearing assertion: the grip is in the DOM but hidden from assistive technology,
    // because a pointer-only affordance announced to a screen reader would be a control it
    // cannot operate. The wrapper itself is a role-less, name-less div, so nothing here reaches
    // the accessibility tree.
    const glyph = handle.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');

    // Plugin behavior, asserted more loosely: hidden at rest, shown on block hover; draggable,
    // which is the whole point of the element existing.
    expect(handle.style.visibility).toBe('hidden');
    expect(handle.draggable).toBe(true);
  });
});

describe('a change that would empty the document', () => {
  // ProseMirror cannot empty a document - `doc` is `block+`, so deleting everything leaves one
  // empty paragraph - but the Yjs layer underneath it can: the undo manager unwinds history
  // below ProseMirror's floor. The sync binding does heal an emptied fragment, but a render
  // cycle later - and in that gap collab-sync's flush timer can fire, or a teardown can flush,
  // and the emptying update goes to the server alone. The collaboration service refuses it as a
  // document it could never reopen and forces a resync, which on screen reads as an edit that
  // silently did not take. Observed in a dev log as `document_does_not_parse` with `fragment
  // held: nothing` against a note whose stored state was three healthy paragraphs.
  //
  // The emptying in these tests is done directly on the shared document rather than through the
  // interface, because that is the seam being guarded: whatever produced it upstream, a local
  // transaction with no children left is the event the editor must answer.

  /** Opens the editor, makes one edit, and returns the document and its content fragment. */
  async function openWithAHeading(): Promise<{
    user: ReturnType<typeof userEvent.setup>;
    doc: Y.Doc;
    fragment: Y.XmlFragment;
  }> {
    const user = userEvent.setup();
    const doc = await open();

    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    const fragment = doc.getXmlFragment('default');
    await waitFor(() => {
      expect(fragment.toArray().length).toBeGreaterThan(0);
    });

    return { user, doc, fragment };
  }

  it('restores one paragraph before the emptying can be sent', async () => {
    const { doc, fragment } = await openWithAHeading();

    doc.transact(() => {
      fragment.delete(0, fragment.length);
    });

    // Restored by the time the transaction returns, not merely eventually: collab-sync holds
    // every update behind its flush timer, so two updates queued in one tick always share a
    // flush - which is the property that keeps a send boundary from falling between the
    // emptying and the restoration. Exactly one paragraph, because the binding's own healing
    // runs afterwards and must not contribute a second.
    expect(fragment.toArray().length).toBe(1);
    expect(JSON.stringify(fragment.toJSON())).toContain('paragraph');

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(fragment.toArray().length).toBe(1);
  });

  it('leaves a remote emptying for the peer that produced it to answer', async () => {
    // A peer that empties the shared document is running this same guard, and both sides
    // answering would leave two paragraphs in the merged result. The refusal of unparseable
    // updates is the server's job; this editor speaks only for its own edits.
    const { doc, fragment } = await openWithAHeading();

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerFragment = peer.getXmlFragment('default');
    const before = Y.encodeStateVector(doc);
    peer.transact(() => {
      peerFragment.delete(0, peerFragment.length);
    });

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, before));

    expect(fragment.toArray().length).toBe(0);
    peer.destroy();
  });

  it('keeps the restored paragraph through a further undo', async () => {
    // The restoration is written under an origin the undo manager does not track, so unwinding
    // further cannot take the document back below the floor the restoration re-established.
    const { user, fragment } = await openWithAHeading();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(fragment.toArray().length).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(fragment.toArray().length).toBe(1);
      expect(JSON.stringify(fragment.toJSON())).toContain('paragraph');
    });
  });

  it('removes the placeholder again when a collaborator brings content back', async () => {
    // The cleanup cannot wait for this person's next edit: after an undo to blank, a colleague
    // still typing would otherwise share a document carrying a blank block nobody authored -
    // and if the undoer walks away, it stays. Removing on any origin is safe because the guard
    // only ever deletes the one element it created, and only while that element is empty.
    const { doc, fragment } = await openWithAHeading();

    doc.transact(() => {
      fragment.delete(0, fragment.length);
    });
    expect(fragment.toArray().length).toBe(1);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(doc);
    peer.transact(() => {
      peer.getXmlFragment('default').push([new Y.XmlElement('heading')]);
    });

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, before));

    await waitFor(() => {
      expect(fragment.toArray().length).toBe(1);
      expect(JSON.stringify(fragment.toJSON())).toContain('heading');
    });
    peer.destroy();
  });

  it('removes the placeholder again when redo brings the content back', async () => {
    // Without this, undo-then-redo would permanently add a blank block the person never
    // authored - and being untracked, no undo could ever remove it. The placeholder is the
    // guard's to manage only while it stays empty; the moment real content returns beside it,
    // it goes, and the document is exactly what the undo removed.
    const { user, fragment } = await openWithAHeading();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(fragment.toArray().length).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => {
      expect(fragment.toArray().length).toBe(1);
      expect(JSON.stringify(fragment.toJSON())).toContain('heading');
    });
  });
});

describe('a toggle in the real editor', () => {
  /**
   * `toggle-button.test.tsx` proves the two renderers behave; this proves this component is
   * the one that installs them. Without it, `note-editor.tsx` could drop either from its
   * extension list and every keyboard test there would still pass against a harness that
   * wires them by hand.
   *
   * The toggle arrives through the shared document rather than through the interface,
   * because that is the one seam this test has into the editor the component builds for
   * itself - and it is the same seam the collaboration service writes through in production.
   */
  it('draws the disclosure button and the heading semantics this app configures', async () => {
    const doc = await open();
    const fragment = doc.getXmlFragment('default');

    doc.transact(() => {
      const summary = new Y.XmlElement('detailsSummary');
      summary.insert(0, [new Y.XmlText('Plan')]);

      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Hidden body')]);
      const content = new Y.XmlElement('detailsContent');
      content.insert(0, [paragraph]);

      const details = new Y.XmlElement('details');
      details.setAttribute('toggleLevel', '2');
      details.insert(0, [summary, content]);

      fragment.insert(0, [details]);
    });

    // The disclosure control, named after its section with the state in `aria-expanded` -
    // `renderToggleButton`'s contract, reached only because this component passes it in.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });

    // And the summary's heading semantics, which come from the node view rather than from
    // any class: a toggle heading that is only a type step is a hierarchy no screen reader
    // can hear.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Plan');
  });
});

describe('note composition actions', () => {
  it('uploads clipboard images without requiring an address', async () => {
    const doc = await open();
    const fileItemId = '00000000-0000-4000-8000-000000000077';
    fileHarness.uploadAndCompleteFile.mockResolvedValue({
      itemId: fileItemId,
      current: { previewable: true },
    });
    fireEvent.paste(screen.getByLabelText('Note body'), {
      clipboardData: {
        getData: () => '',
        files: [new File(['image'], 'clipboard.png', { type: 'image/png' })],
      },
    });
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain(fileItemId);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('inserts a page boundary from the menu into the shared document and undoes it', async () => {
    const doc = await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Block type:/ }));
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Page break' }));
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain('pagebreak');
    });
    expect(screen.getByRole('button', { name: 'Remove page break' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).not.toContain('pagebreak');
    });
  });
});

it('closes the picker after inserting a section before a heading and leaves a paragraph', async () => {
  const doc = await open();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /^Block type:/ }));
  await user.click(screen.getByRole('button', { name: 'Heading 1' }));
  const id = '00000000-0000-4000-8000-000000000077';
  fileHarness.client.query.mockResolvedValueOnce(
    Object.assign(
      { references: [] },
      {
        query: 'Source',
        truncated: false,
        results: [
          {
            id,
            title: 'Source note',
            type: 'note',
            workspaceId: '00000000-0000-4000-8000-000000000002',
          },
        ],
      },
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Insert' }));
  await user.click(screen.getByRole('button', { name: 'Embed note' }));
  await user.type(screen.getByRole('textbox', { name: 'Search this workspace' }), 'Source');
  await user.click(await screen.findByRole('button', { name: 'Source note' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const content = doc.getXmlFragment('default').toArray();
  const index = content.findIndex(
    (node) => node instanceof Y.XmlElement && node.nodeName === 'itemBlock',
  );
  expect(index).toBeGreaterThanOrEqual(0);
  expect(content[index + 1]).toBeInstanceOf(Y.XmlElement);
  expect((content[index + 1] as Y.XmlElement).nodeName).toBe('paragraph');
});

it('keeps collaboration updates connected after StrictMode remounts effects', async () => {
  const view = render(
    <StrictMode>
      <ApiClientProvider>
        <NoteEditor itemId="00000000-0000-4000-8000-000000000001" />
      </ApiClientProvider>
    </StrictMode>,
  );
  await waitFor(() => {
    expect(captured).not.toBeNull();
  });
  const doc = captured;
  if (doc === null) throw new Error('No shared document');
  expect(doc.isDestroyed).toBe(false);
  const update = vi.fn();
  doc.on('update', update);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /^Block type:/ }));
  await user.click(screen.getByRole('button', { name: 'Heading 1' }));
  expect(update).toHaveBeenCalled();
  view.unmount();
  await waitFor(() => {
    expect(doc.isDestroyed).toBe(true);
  });
});
