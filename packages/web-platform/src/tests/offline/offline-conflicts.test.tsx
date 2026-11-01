import type { MirrorConflict } from '@nix/sync-core/mirror';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setNativeMirror, type NativeMirror } from '../../offline/native-mirror';
import { OfflineConflicts } from '../../offline/offline-conflicts';
import { recoveryText } from '../../offline/recovery-text';

const WS = '0199a000-0000-7000-8000-000000000001';
const ITEM = '0199a000-0000-7000-8000-000000000010';

function paragraphs(...lines: string[]): Uint8Array {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  for (const line of lines) {
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, line);
    paragraph.insert(0, [text]);
    fragment.insert(fragment.length, [paragraph]);
  }
  return Y.encodeStateAsUpdate(doc);
}

describe('recoveryText', () => {
  it('reads the words of a refused note edit, one paragraph per line', () => {
    expect(recoveryText(paragraphs('First', 'Second'))).toBe('First\nSecond');
  });
});

describe('offline conflicts', () => {
  afterEach(() => {
    cleanup();
    setNativeMirror(null);
  });

  function mount(conflicts: MirrorConflict[]) {
    const store = {
      readWorkspaceList: () => Promise.resolve([{ id: WS, name: 'Home' }]),
      listConflicts: vi.fn(() => Promise.resolve(conflicts)),
      readItems: () => Promise.resolve([{ id: ITEM, title: 'Shopping' }]),
      readConflictRecovery: () => Promise.resolve(paragraphs('milk', 'eggs')),
      dismissConflict: vi.fn(() => {
        conflicts.length = 0;
        return Promise.resolve();
      }),
      subscribe: () => () => undefined,
    };
    setNativeMirror({ current: () => store } as unknown as NativeMirror);
    render(<OfflineConflicts />);
    return store;
  }

  it('renders nothing when there are no conflicts or no mirror', () => {
    const view = render(<OfflineConflicts />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it('lists a refused change with its code and lets the person dismiss it', async () => {
    const user = userEvent.setup();
    const store = mount([
      {
        id: 'op1',
        workspaceId: WS,
        itemId: ITEM,
        kind: 'metadata',
        code: 'revision_conflict',
        operation: {
          kind: 'rename',
          operationId: '0199a000-0000-7000-8000-0000000000a1',
          itemId: ITEM,
          expectedRevision: '1',
          payload: { title: 'x' },
        },
        createdAt: '2026-11-01T10:00:00Z',
      },
    ]);
    await user.click(await screen.findByRole('button', { name: '1 change needs attention' }));
    expect(await screen.findByText('Shopping')).toBeInTheDocument();
    expect(screen.getByText(/Rename — revision_conflict/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy text' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(store.dismissConflict).toHaveBeenCalledWith(WS, 'op1');
    await waitFor(() => {
      expect(screen.queryByText('Shopping')).toBeNull();
    });
  });

  it('copies the text of a refused note edit', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount([
      {
        id: `body:${ITEM}`,
        workspaceId: WS,
        itemId: ITEM,
        kind: 'body',
        code: 'document_changed',
        operation: null,
        createdAt: '2026-11-01T10:00:00Z',
      },
    ]);
    await user.click(await screen.findByRole('button', { name: '1 change needs attention' }));
    await user.click(await screen.findByRole('button', { name: 'Copy text' }));
    expect(writeText).toHaveBeenCalledWith('milk\neggs');
  });
});
