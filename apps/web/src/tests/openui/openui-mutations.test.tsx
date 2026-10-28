import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = '11111111-1111-4111-8111-111111111111';
const task = '22222222-2222-4222-8222-222222222222';
const client = { query: vi.fn(), execute: vi.fn(), invalidate: vi.fn() };
const run = vi.fn();
const prepareWrite = vi.fn();
const afterWrite = vi.fn();

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
  useOptionalApiClient: () => client,
}));
vi.mock('@nix/companion', () => ({
  runWorkspaceTool: run,
  createCompanionBodies: () => ({}),
  defaultClock: () => ({}),
  defaultIds: () => ({}),
}));
vi.mock('../../pets/approval/prepare-write', () => ({ prepareWrite, afterWrite }));

const { default: OpenUiBlock } = await import('../../openui/openui-block');

function model(headline: string) {
  return {
    headline,
    destination: { title: 'Tasks', path: [] },
    counts: { items: 0, fields: 0, views: 0, entries: 0, writes: 1 },
    tree: [],
    notes: [],
    warnings: [],
    problems: [],
    neverDoes: [],
  };
}

const finishTask = (operation = 'complete_task', args = `itemId: "${task}", completed: true`) => `
root = Stack([go, said])
finish = Mutation("${operation}", {${args}})
go = Button("Do it", @Run(finish), "primary")
said = Text(finish.status == "error" ? "Not done" : finish.status == "success" ? "Done!" : "Waiting", "body")`;

function block(
  source: string,
  applyWithoutAsking = false,
  extra: Partial<ComponentProps<typeof OpenUiBlock>> = {},
) {
  const view = (apply: boolean) => (
    <MemoryRouter>
      <OpenUiBlock
        source={source}
        workspaceIds={[workspace]}
        fallback={<pre>fallback</pre>}
        applyWithoutAsking={apply}
        {...extra}
      />
    </MemoryRouter>
  );
  const rendered = render(view(applyWithoutAsking));
  return {
    ...rendered,
    setApply: (apply: boolean) => {
      rendered.rerender(view(apply));
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareWrite.mockResolvedValue({
    model: model('I will mark Pay rent done'),
    fingerprint: 'fence-1',
    taskOccurrence: false,
    refusalQuotesLockedContent: false,
  });
  run.mockResolvedValue({
    text: '{"completed":true}',
    readOnly: false,
    touchedParents: [],
    lockedContent: false,
  });
});

describe('component writes', () => {
  it('wait for the owner, then run what was approved under its fence', async () => {
    block(finishTask());
    fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
    expect(await screen.findByText('I will mark Pay rent done')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    expect(await screen.findByText('Done!')).toBeInTheDocument();
    // The card is gone, so focus lands on the block rather than dropping to the page.
    expect(document.querySelector('[data-openui-block]')).toHaveFocus();
    const [, ranIn, raw, , options] = run.mock.calls[0] as [
      unknown,
      string,
      string,
      unknown,
      unknown,
    ];
    expect(ranIn).toBe(workspace);
    expect(JSON.parse(raw)).toMatchObject({
      operation: 'complete_task',
      itemId: task,
      specJson: '{"completed":true}',
    });
    expect(options).toEqual({ fence: 'fence-1' });
    expect(afterWrite).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
  });

  it('run nothing when declined, and the component sees the error', async () => {
    block(finishTask());
    fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Decline request' }));
    expect(await screen.findByText('Not done')).toBeInTheDocument();
    expect(document.querySelector('[data-openui-block]')).toHaveFocus();
    expect(run).not.toHaveBeenCalled();
  });

  it('run without a click under "Apply without asking" when the preview is clean', async () => {
    block(finishTask(), true);
    fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
    expect(await screen.findByText('Done!')).toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(1);
    // An auto-run never takes focus from where the owner is.
    expect(document.querySelector('[data-openui-block]')).not.toHaveFocus();
  });

  it('always wait for operations the switch never covers', async () => {
    block(finishTask('trash_item', `itemId: "${task}"`), true);
    fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
    expect(await screen.findByRole('button', { name: 'Approve request' })).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(run).not.toHaveBeenCalled();
  });

  it('wait after any query in the block read locked content', async () => {
    run.mockResolvedValueOnce({
      text: '{"items":[]}',
      readOnly: true,
      touchedParents: [],
      lockedContent: true,
    });
    block(
      `root = Stack([list, go, said])
rows = Query("list_items", {}, {items: []})
list = ItemList(rows.items, "Nothing")
finish = Mutation("complete_task", {itemId: "${task}", completed: true})
go = Button("Do it", @Run(finish), "primary")
said = Text(finish.status == "success" ? "Done!" : "Waiting", "body")`,
      true,
    );
    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
    expect(
      await screen.findByText(
        'This one waits for you: earlier reads need your review before changes.',
      ),
    ).toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never show a card for a request that does not parse', async () => {
    block(finishTask('complete_task', 'completed: true'));
    fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
    expect(await screen.findByText('Not done')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    expect(prepareWrite).not.toHaveBeenCalled();
  });

  describe('security review fixes', () => {
    it('give a program no write tools when a Query names a write (H3)', async () => {
      block(
        `root = Stack([go, said])
spam = Query("append_note", {itemId: "${task}", markdown: "x"}, {}, 1)
finish = Mutation("complete_task", {itemId: "${task}", completed: true})
go = Button("Do it", @Run(finish), "primary")
said = Text(finish.status == "error" ? "Not done" : spam.status == "x" ? "" : "Waiting", "body")`,
        true,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
      expect(await screen.findByText('Not done')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
      expect(prepareWrite).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it('keep one write waiting at a time (H3)', async () => {
      block(`root = Stack([a, b, said])
one = Mutation("complete_task", {itemId: "${task}", completed: true})
two = Mutation("complete_task", {itemId: "${task}", completed: false})
a = Button("First", @Run(one))
b = Button("Second", @Run(two))
said = Text(two.status == "error" ? "Second refused" : "", "body")`);
      fireEvent.click(await screen.findByRole('button', { name: 'First' }));
      expect(await screen.findByRole('button', { name: 'Approve request' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Second' }));
      expect(await screen.findByText('Second refused')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Approve request' })).toHaveLength(1);
    });

    it('hold writes after the conversation read locked content (H1)', async () => {
      block(finishTask(), true, { followsLockedRead: true });
      fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
      expect(
        await screen.findByText(
          'This one waits for you: earlier reads need your review before changes.',
        ),
      ).toBeInTheDocument();
      expect(run).not.toHaveBeenCalled();
    });

    it('offer no writes in a read-only note scope, and bound the rest by it (H2)', async () => {
      const scoped = block(finishTask(), false, {
        noteScope: { rootItemId: task, readOnly: true },
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
      expect(await screen.findByText('Not done')).toBeInTheDocument();
      expect(prepareWrite).not.toHaveBeenCalled();
      scoped.unmount();

      block(finishTask(), false, { noteScope: { rootItemId: task, readOnly: false } });
      fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Approve request' }));
      expect(await screen.findByText('Done!')).toBeInTheDocument();
      expect(prepareWrite.mock.calls[0]?.[4]).toEqual({ rootItemId: task, readOnly: false });
      expect(run.mock.calls[0]?.[4]).toEqual({
        fence: 'fence-1',
        scope: { rootItemId: task, readOnly: false },
      });
    });

    it('never approve a card that was already waiting when the switch went on (L1)', async () => {
      const view = block(finishTask());
      fireEvent.click(await screen.findByRole('button', { name: 'Do it' }));
      expect(await screen.findByRole('button', { name: 'Approve request' })).toBeEnabled();
      view.setApply(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(run).not.toHaveBeenCalled();
    });
  });
});
