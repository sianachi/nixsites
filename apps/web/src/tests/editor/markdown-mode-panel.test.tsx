import type { NixClient } from '@nix/api-client';
import { nixSchema } from '@nix/editor-schema';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ReactNode } from 'react';
import * as Y from 'yjs';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { snapshotMarkdown } from '@nix/web-editor/editor/markdown-mode';
import {
  MarkdownLossesDialog,
  MarkdownModePanel,
} from '@nix/web-editor/editor/markdown-mode-panel';

const ALPHA = {
  id: '0192f2a0-7c1e-7000-8000-0000000000a1',
  workspaceId: 'w1',
  type: 'note',
  title: 'Alpha plan',
  parentId: null,
  updatedAt: '2026-01-01T00:00:00Z',
};

/** The panel with a client whose item search answers with `hits`. */
function withSearch(panel: ReactNode, hits: readonly unknown[] = []): ReactNode {
  const client = {
    query: vi.fn().mockResolvedValue({ query: '', results: hits, limit: 25, truncated: false }),
  } as unknown as NixClient;
  return <ApiClientOverrideProvider client={client}>{panel}</ApiClientOverrideProvider>;
}

function note(): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  prosemirrorJSONToYXmlFragment(
    nixSchema,
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] },
    fragment,
  );
  return { doc, fragment };
}

it('applies edited Markdown to the note and closes, and cancels without writing', async () => {
  const user = userEvent.setup();
  const { doc, fragment } = note();
  const onClose = vi.fn();
  render(
    withSearch(
      <MarkdownModePanel
        doc={doc}
        fragment={fragment}
        snapshot={snapshotMarkdown(fragment)}
        onClose={onClose}
      />,
    ),
  );
  const box = screen.getByRole('textbox', { name: 'Note as Markdown' });
  expect(box).toHaveDisplayValue(/^Body\s*$/);
  await user.clear(box);
  await user.type(box, '# Title');
  await user.click(screen.getByRole('button', { name: 'Apply Markdown' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  const json = yXmlFragmentToProseMirrorRootNode(fragment, nixSchema).toJSON() as {
    content: { type: string }[];
  };
  expect(json.content[0]?.type).toBe('heading');
});

it('warns when a colleague changed the note and asks before replacing their change', async () => {
  const user = userEvent.setup();
  const { doc, fragment } = note();
  render(
    withSearch(
      <MarkdownModePanel
        doc={doc}
        fragment={fragment}
        snapshot={snapshotMarkdown(fragment)}
        onClose={vi.fn()}
      />,
    ),
  );
  const other = new Y.Doc();
  prosemirrorJSONToYXmlFragment(
    nixSchema,
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Theirs' }] }] },
    other.getXmlFragment('default'),
  );
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), 'remote');
  expect(await screen.findByText(/Someone changed this note/)).toBeVisible();

  await user.type(screen.getByRole('textbox', { name: 'Note as Markdown' }), ' more');
  await user.click(screen.getByRole('button', { name: 'Apply Markdown' }));
  expect(screen.getByRole('dialog', { name: 'Replace their change?' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('lists the losses before entering and lets the person cancel', async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  render(
    <MarkdownLossesDialog
      snapshot={{ markdown: '', losses: [{ kind: 'columns', detail: 'Columns are flattened.' }] }}
      onContinue={vi.fn()}
      onCancel={onCancel}
    />,
  );
  expect(screen.getByText('Columns are flattened.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalled();
});

describe('the [[ note-link picker', () => {
  function renderPicker(outerEscape: () => void, onClose: () => void): HTMLElement {
    const { doc, fragment } = note();
    render(
      withSearch(
        <MarkdownModePanel
          doc={doc}
          fragment={fragment}
          snapshot={snapshotMarkdown(fragment)}
          onClose={onClose}
        />,
        [ALPHA],
      ),
    );
    // Stands in for the dialog behind the panel: it closes on any Escape that reaches it.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') outerEscape();
    };
    document.addEventListener('keydown', onKeyDown);
    onTestFinished(() => {
      document.removeEventListener('keydown', onKeyDown);
    });
    return screen.getByRole('textbox', { name: 'Note as Markdown' });
  }

  // user-event reads `[` as the start of a key descriptor, so a literal `[` is typed as `[[`.
  const typeTrigger = async (box: HTMLElement) => {
    const user = userEvent.setup();
    await user.clear(box);
    await user.type(box, '[[[[abc');
    return user;
  };

  it('lists matches under the textarea and Enter replaces the query with a link', async () => {
    const box = renderPicker(vi.fn(), vi.fn());
    const user = await typeTrigger(box);

    const option = await screen.findByRole('option', { name: 'Alpha plan' });
    expect(screen.getByRole('listbox', { name: 'Items to link to' })).toContainElement(option);
    expect(box).toHaveAttribute('aria-activedescendant', option.id);

    await user.keyboard('{Enter}');
    expect(box).toHaveDisplayValue(`[Alpha plan](nix://item/${ALPHA.id})`);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on Escape without closing what is behind it, and reopens on a fresh [[', async () => {
    const outerEscape = vi.fn();
    const onClose = vi.fn();
    const box = renderPicker(outerEscape, onClose);
    const user = await typeTrigger(box);
    await screen.findByRole('option', { name: 'Alpha plan' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box).toHaveDisplayValue('[[abc');
    expect(outerEscape).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.clear(box);
    await user.type(box, '[[[[abc');
    expect(await screen.findByRole('option', { name: 'Alpha plan' })).toBeVisible();
  });
});
