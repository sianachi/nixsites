import { nixEditingExtensions } from '@nix/editor-schema';
import type { NixClient, QueryEndpoint } from '@nix/api-client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '../../api/api-client-provider';
import { CANDIDATE_POOL, linkFrecencyNamespace, ReferenceMenu } from '../../editor/reference-menu';
import { frecencyScores, recordPick } from '@nix/web-foundation/lib/frecency';
import { useChoiceOrderPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { memoryStorage } from '../memory-storage';

/**
 * The picker's re-rank against a real editor and a fake client: it asks for a pool larger than it
 * shows, shows the person's usual pick first, and remembers what was inserted.
 */

const WORKSPACE = 'workspace-1';

/** Twelve "Plan" items in server order; more than the eight the picker shows. */
const HITS = Array.from({ length: 12 }, (_, index) => ({
  id: `plan-${String(index)}`,
  workspaceId: WORKSPACE,
  type: 'note',
  title: `Plan ${String(index)}`,
}));

let captured: Editor | null = null;
let query: ReturnType<typeof vi.fn>;

function Harness(): ReactNode {
  const editor = useEditor({
    extensions: [...nixEditingExtensions],
    onCreate: ({ editor: created }) => {
      captured = created;
    },
  });
  const client = { query } as unknown as NixClient;
  return (
    <ApiClientOverrideProvider client={client}>
      <ReferenceMenu editor={editor} workspaceId={WORKSPACE} itemId="current-note" />
      <EditorContent editor={editor} />
    </ApiClientOverrideProvider>
  );
}

async function openWith(content: string): Promise<Editor> {
  render(<Harness />);
  await waitFor(() => {
    expect(captured).not.toBeNull();
  });
  const editor = captured;
  if (editor === null) throw new Error('The editor never reported itself created.');
  // jsdom performs no layout; the caret's coordinates only position the floating box.
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 0, top: 0, right: 0, bottom: 0 });
  act(() => {
    editor.commands.insertContent(content);
  });
  return editor;
}

beforeEach(() => {
  captured = null;
  vi.stubGlobal('localStorage', memoryStorage());
  query = vi.fn((endpoint: Pick<QueryEndpoint<unknown>, 'operation'>) =>
    Promise.resolve(
      endpoint.operation === 'items.related'
        ? { related: [], limit: CANDIDATE_POOL, truncated: false }
        : { query: 'plan', results: HITS, limit: CANDIDATE_POOL, truncated: false },
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ranking the reference picker', () => {
  it('asks the server for the candidate pool and shows eight of it', async () => {
    await openWith('[[plan');

    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(8);
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ query: { q: 'plan', limit: CANDIDATE_POOL } }),
      expect.anything(),
    );
  });

  it('shows the item this person links to most in this workspace first, even from past the eighth', async () => {
    recordPick(linkFrecencyNamespace(WORKSPACE), 'plan-11');
    recordPick(linkFrecencyNamespace(WORKSPACE), 'plan-11');

    await openWith('[[plan');

    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]).toHaveTextContent('Plan 11');
    });
  });

  it('ignores pick history when ordering by picks is off', async () => {
    useChoiceOrderPreference.setState({ setting: 'off', saved: true });
    recordPick(linkFrecencyNamespace(WORKSPACE), 'plan-11');
    recordPick(linkFrecencyNamespace(WORKSPACE), 'plan-11');

    try {
      await openWith('[[plan');

      await waitFor(() => {
        expect(screen.getAllByRole('option')[0]).toHaveTextContent('Plan 0');
      });
    } finally {
      useChoiceOrderPreference.setState({ setting: 'on', saved: true });
    }
  });

  it('ignores picks made in another workspace', async () => {
    recordPick(linkFrecencyNamespace('workspace-2'), 'plan-11');

    await openWith('[[plan');

    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]).toHaveTextContent('Plan 0');
    });
    expect(screen.queryByRole('option', { name: /Plan 11/ })).not.toBeInTheDocument();
  });

  it('remembers the inserted item for the next search in this workspace', async () => {
    const editor = await openWith('[[plan');
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(8);
      expect(editor.view.dom).toHaveAttribute(
        'aria-activedescendant',
        screen.getByRole('option', { name: 'Plan 0' }).id,
      );
    });

    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    expect(frecencyScores(linkFrecencyNamespace(WORKSPACE)).get('plan-0')).toBeCloseTo(1);
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe('reference');
    expect(editor.state.doc.firstChild?.firstChild?.attrs.targetId).toBe('plan-0');
  });
});
