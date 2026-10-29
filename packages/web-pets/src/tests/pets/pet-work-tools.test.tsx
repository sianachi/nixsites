import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { petConnectionSchema, type NixClient } from '@nix/api-client';
import type * as Companion from '@nix/companion';
import { PetWorkTools } from '../../pets/work-tools/pet-work-tools';
import { PetWorkToolCard } from '../../pets/work-tools/tool-card';
import { onItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { MemoryRouter } from 'react-router';
import { useState, type ReactElement } from 'react';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { nixSchema } from '@nix/editor-schema';
import { markdownToDocument } from '@nix/markdown';
import * as actionReceipts from '../../pets/action-receipts';

const client = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn(), invalidate: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
  useOptionalApiClient: () => client,
}));
// The executor's own behaviour is covered by packages/companion/src/run.test.ts; here it
// runs for real against the mocked Nix client above, wrapped in a spy so a test can assert
// the card forwards this request's toolId and claimId into the run options.
const runWorkspaceToolSpy = vi.hoisted(() => vi.fn());
// The real executor, restored before every test: `vi.clearAllMocks` keeps an implementation a
// test replaced (`mockResolvedValue`), and that canned result would otherwise answer later tests.
const realRun: { current: typeof Companion.runWorkspaceTool } = vi.hoisted(() => ({
  current: () => {
    throw new Error('The real executor has not loaded yet.');
  },
}));
function useRealRun() {
  runWorkspaceToolSpy.mockImplementation((...args: Parameters<typeof Companion.runWorkspaceTool>) =>
    realRun.current(...args),
  );
}
vi.mock('@nix/companion', async () => {
  const actual = await vi.importActual<typeof Companion>('@nix/companion');
  realRun.current = actual.runWorkspaceTool;
  useRealRun();
  return { ...actual, runWorkspaceTool: runWorkspaceToolSpy };
});
const runtime = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: '',
  canConnect: false,
  tools: [
    {
      id: 'tool-1',
      arguments: JSON.stringify({
        operation: 'create_note',
        title: 'Plan',
        markdown: '',
        itemId: '',
        parentId: '',
        query: '',
        propertiesJson: '',
      }),
      status: 'pending',
      result: '',
      claimId: '',
    },
  ],
});
function show() {
  return render(
    <PetWorkTools
      client={client as unknown as NixClient}
      runtime={runtime}
      workspaceId="11111111-1111-4111-8111-111111111111"
      petId="22222222-2222-4222-8222-222222222222"
      onChange={vi.fn()}
    />,
  );
}
async function approveRequest() {
  const button = screen.getByRole('button', { name: 'Approve request' });
  await waitFor(() => {
    expect(button).toBeEnabled();
  });
  await userEvent.click(button);
}
function requestOperations(): string[] {
  return client.execute.mock.calls.map(
    ([endpoint]) => (endpoint as { body: { operation: string } }).body.operation,
  );
}
describe('companion work approvals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRealRun();
    sessionStorage.clear();
  });
  it('passes the complete approved source fingerprint for template saving', async () => {
    const fingerprint = 'a'.repeat(64);
    const saveRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        arguments: JSON.stringify({
          operation: 'save_as_template',
          itemId: '33333333-3333-4333-8333-333333333333',
          parentId: '',
          title: 'Job hunt',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: '{}',
        }),
      })),
    };
    client.query.mockImplementation((endpoint: { operation: string; path: string }) => {
      if (endpoint.operation !== 'templates.capture.preview')
        throw new Error(`Unexpected preview query: ${endpoint.operation}`);
      const excluded = endpoint.path.includes('excludeSampleDescendants=true');
      return Promise.resolve({
        fingerprint,
        captureFingerprint: excluded ? 'b'.repeat(64) : fingerprint,
        sourceTitle: 'Applications',
        itemCount: excluded ? 2 : 3,
      });
    });
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...saveRuntime,
          tools: saveRuntime.tools.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    runWorkspaceToolSpy.mockResolvedValueOnce({
      text: 'saved',
      readOnly: false,
      touchedParents: [],
    });
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={saveRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    expect(await screen.findByText(/I will save “Applications” and 1 children/)).toBeVisible();
    expect(screen.getByText(/· 2 items to copy, 1 template write$/)).toBeVisible();
    expect(screen.queryByText(/0 fields, 0 views/)).not.toBeInTheDocument();
    await approveRequest();
    await waitFor(() => {
      expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
    });
    expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({
      fence: fingerprint,
    });
  });
  it('never executes when the server claim is uncertain', async () => {
    client.execute.mockRejectedValue(new Error('lost claim response'));
    show();
    expect(client.execute).not.toHaveBeenCalled();
    await approveRequest();
    await screen.findByRole('alert');
    expect(client.execute).toHaveBeenCalledTimes(2);
    expect(client.execute.mock.calls[0]?.[0]).toMatchObject({ body: { operation: 'tool_claim' } });
    expect(client.execute.mock.calls[1]?.[0]).toMatchObject({ body: { operation: 'read' } });
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
  });

  it.each(['claimed', 'completed', 'failed', 'interrupted'] as const)(
    'reconciles a refused claim with authoritative %s status without executing or reporting a failure',
    async (status) => {
      const observed = {
        ...runtime,
        revision: 2,
        tools: runtime.tools?.map((tool) => ({ ...tool, status, claimId: 'another-session' })),
      };
      const onChange = vi.fn();
      client.execute.mockImplementation((endpoint: { body: { operation: string } }) =>
        endpoint.body.operation === 'read'
          ? Promise.resolve(observed)
          : Promise.reject(new Error('tool already claimed')),
      );
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={runtime}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          onChange={onChange}
        />,
      );
      await approveRequest();
      await waitFor(() => {
        expect(onChange).toHaveBeenCalledExactlyOnceWith(observed);
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
      expect(requestOperations()).toEqual(['tool_claim', 'read']);
      expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    },
  );

  it.each(['pending', 'own-claim', 'missing'] as const)(
    'keeps the uncertainty warning when reconciliation finds %s',
    async (observation) => {
      let requestId = '';
      client.execute.mockImplementation(
        (endpoint: { body: { operation: string; requestId?: string } }) => {
          if (endpoint.body.operation === 'tool_claim') {
            requestId = endpoint.body.requestId ?? '';
            return Promise.reject(new Error('lost claim response'));
          }
          return Promise.resolve({
            ...runtime,
            tools:
              observation === 'missing'
                ? []
                : runtime.tools?.map((tool) => ({
                    ...tool,
                    status: observation === 'own-claim' ? 'claimed' : 'pending',
                    claimId: observation === 'own-claim' ? requestId : '',
                  })),
          });
        },
      );
      show();
      await approveRequest();
      expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't confirm this change");
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
      expect(requestOperations()).toEqual(['tool_claim', 'read']);
    },
  );

  it.each(['search', 'create_note'] as const)(
    'two independently mounted sessions contend for %s but execute once without a false failure alert',
    async (operation) => {
      // Separate tabs cannot read each other's action receipts. Each mounted panel still
      // retains its own decision state; only the server arbitrates ownership between them.
      const storage = vi.spyOn(actionReceipts, 'readActionReceipt').mockReturnValue('');
      try {
        const pending = petConnectionSchema.parse({
          ...runtime,
          tools: runtime.tools?.map((tool) => ({
            ...tool,
            arguments: JSON.stringify({
              ...JSON.parse(tool.arguments),
              operation,
              query: operation === 'search' ? 'Plan' : '',
            }),
          })),
        });
        let observed = pending;
        client.execute.mockImplementation(
          (endpoint: { body: { operation: string; requestId?: string } }) => {
            if (endpoint.body.operation === 'read') return Promise.resolve(observed);
            if (
              endpoint.body.operation === 'tool_claim' &&
              observed.tools?.[0]?.status !== 'pending'
            )
              return Promise.reject(new Error('tool already claimed'));
            observed = {
              ...observed,
              revision: observed.revision + 1,
              tools: (observed.tools ?? []).map((tool) => ({
                ...tool,
                status: endpoint.body.operation === 'tool_claim' ? 'claimed' : 'completed',
                claimId: endpoint.body.requestId ?? '',
              })),
            };
            return Promise.resolve(observed);
          },
        );
        let finish: (() => void) | undefined;
        runWorkspaceToolSpy.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = () => {
                resolve({ text: 'ok', readOnly: operation === 'search', touchedParents: [] });
              };
            }),
        );
        function Session(): ReactElement {
          const [snapshot, setSnapshot] = useState(pending);
          return (
            <PetWorkTools
              client={client as unknown as NixClient}
              runtime={snapshot}
              workspaceId="11111111-1111-4111-8111-111111111111"
              petId="22222222-2222-4222-8222-222222222222"
              onChange={setSnapshot}
            />
          );
        }
        render(
          <>
            <Session />
            <Session />
          </>,
          { wrapper: MemoryRouter },
        );
        if (operation === 'create_note') {
          const approvals = screen.getAllByRole('button', { name: 'Approve request' });
          await waitFor(() => {
            expect(approvals.every((button) => !button.hasAttribute('disabled'))).toBe(true);
          });
          const [first, second] = approvals;
          if (first === undefined || second === undefined)
            throw new Error('Both sessions must show an approval.');
          await userEvent.click(first);
          await userEvent.click(second);
        }
        await waitFor(() => {
          expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
        });
        await waitFor(() => {
          expect(requestOperations().filter((operation) => operation === 'read')).toHaveLength(1);
        });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(requestOperations().filter((operation) => operation === 'tool_result')).toHaveLength(
          0,
        );
        finish?.();
        await waitFor(() => {
          expect(
            requestOperations().filter((operation) => operation === 'tool_result'),
          ).toHaveLength(1);
        });
        expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
        expect(requestOperations().filter((operation) => operation === 'tool_claim')).toHaveLength(
          2,
        );
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      } finally {
        storage.mockRestore();
      }
    },
  );
  it('shows a "Declined" receipt once a plain decline\'s tool_result succeeds', async () => {
    // The server snapshot deliberately stays `pending` here (a stale or slow-to-settle round
    // trip) so the only source of the "Declined" text is the receipt L4 adds after the
    // `tool_result` POST for a plain decline succeeds - not `tool.status`/`tool.result` on the
    // snapshot itself, which `WriteReceiptRow` also derives a "Declined" label from.
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...runtime,
          tools: runtime.tools?.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_claim' ? 'claimed' : 'pending',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Decline request' }));
    await waitFor(() => {
      expect(screen.getByText('Declined')).toBeVisible();
    });
    expect(screen.queryByRole('button', { name: 'Decline request' })).not.toBeInTheDocument();
  });

  it('moves focus to the receipt row after a click on Decline request', async () => {
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...runtime,
          tools: runtime.tools?.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_claim' ? 'claimed' : 'pending',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Decline request' }));
    const status = await screen.findByText(/^Declined/);
    expect(status.closest('[tabindex="-1"]')).toHaveFocus();
  });

  it('does not take focus for a receipt whose Decline never started, when it settles later', async () => {
    // A click whose decision did not start (`onResolve` answers false, the lock being held
    // elsewhere) is not an owner decision, so a receipt that settles later in another tab must
    // leave the owner's place alone.
    const tool = runtime.tools?.[0];
    if (!tool) throw new Error('fixture has a tool');
    const props = {
      client: client as unknown as NixClient,
      workspaceId: '11111111-1111-4111-8111-111111111111',
      petName: 'Cat',
      busy: false,
      readWithoutAsking: false,
      applyWithoutAsking: false,
      progress: undefined,
      onBuildProgress: vi.fn(),
      onProblemsChange: vi.fn(),
      onPreviewFailedChange: vi.fn(),
      followsLockedRead: false,
      scrollAnchor: false,
      onResolve: vi.fn(() => Promise.resolve(false)),
    };
    const view = render(<PetWorkToolCard {...props} tool={tool} />, { wrapper: MemoryRouter });
    await userEvent.click(screen.getByRole('button', { name: 'Decline request' }));
    const owner = document.createElement('button');
    document.body.append(owner);
    owner.focus();
    view.rerender(
      <PetWorkToolCard {...props} tool={{ ...tool, status: 'completed', result: 'created' }} />,
    );
    await screen.findByText('Done');
    expect(owner).toHaveFocus();
    owner.remove();
  });

  it.each([
    { memoryMode: 'ask', readWithoutAsking: true, asks: true },
    { memoryMode: 'always', readWithoutAsking: false, asks: false },
  ] as const)(
    'a memory follows its own setting, not automatic reads: $memoryMode',
    async ({ memoryMode, readWithoutAsking, asks }) => {
      const tool = {
        id: 'remember-1',
        arguments: JSON.stringify({
          operation: 'remember',
          itemId: '',
          parentId: '',
          title: '',
          markdown: 'Prefers metric units.',
          query: '',
          propertiesJson: '',
          specJson: '',
        }),
        status: 'pending' as const,
        result: '',
        claimId: '',
      };
      const onResolve = vi.fn(() => Promise.resolve(true));
      render(
        <PetWorkToolCard
          client={client as unknown as NixClient}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petName="Cat"
          busy={false}
          readWithoutAsking={readWithoutAsking}
          memoryMode={memoryMode}
          applyWithoutAsking={false}
          progress={undefined}
          onBuildProgress={vi.fn()}
          onProblemsChange={vi.fn()}
          onPreviewFailedChange={vi.fn()}
          followsLockedRead={false}
          scrollAnchor={false}
          onResolve={onResolve}
          tool={tool}
        />,
        { wrapper: MemoryRouter },
      );
      if (asks) {
        expect(await screen.findByRole('button', { name: 'Approve request' })).toBeVisible();
        expect(onResolve).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => {
          expect(onResolve).toHaveBeenCalledWith(tool, true);
        });
        expect(screen.queryByRole('button', { name: 'Approve request' })).toBeNull();
      }
    },
  );

  it("moves focus to the row after a click on a read's Approve request", async () => {
    const readRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        arguments: JSON.stringify({ ...JSON.parse(tool.arguments), operation: 'list_items' }),
      })),
    };
    client.execute.mockImplementation(() => new Promise(() => undefined));
    localStorage.setItem('nix.pet.readWithoutAsking', 'false');
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={readRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    const status = await screen.findByText(/^Approval submitted/);
    expect(status.closest('[tabindex="-1"]')).toHaveFocus();
    localStorage.removeItem('nix.pet.readWithoutAsking');
  });

  it('does not move focus when a read runs on its own', async () => {
    const owner = document.createElement('button');
    document.body.append(owner);
    owner.focus();
    client.execute.mockImplementation(() => new Promise(() => undefined));
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={{
          ...runtime,
          tools: (runtime.tools ?? []).map((tool) => ({
            ...tool,
            arguments: JSON.stringify({ ...JSON.parse(tool.arguments), operation: 'list_items' }),
          })),
        }}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    // Reads run without asking by default; the owner's place is theirs.
    await screen.findByText(/Listing items|Listed items/);
    expect(owner).toHaveFocus();
    owner.remove();
  });

  it.each(['create_note', 'append_note'])(
    'shows the full pending %s content inline, with no folding, as a labelled line',
    async (operation) => {
      const content = 'x'.repeat(340);
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={{
            ...runtime,
            tools: (runtime.tools ?? []).map((tool) => ({
              ...tool,
              arguments: JSON.stringify({
                operation,
                title: operation === 'create_note' ? 'Plan' : '',
                markdown: content,
                itemId: operation === 'append_note' ? '33333333-3333-4333-8333-333333333333' : '',
                parentId: '',
                query: '',
                propertiesJson: '',
              }),
            })),
          }}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
        />,
        { wrapper: MemoryRouter },
      );
      // Security fix S1: a pending card never folds its content behind "Show content" - the
      // full text is already in the DOM, in a focusable region, with a plain line count next
      // to it.
      const name = operation === 'create_note' ? 'Note body' : 'Added note text';
      const label = await screen.findByText(name);
      expect(label.tagName).toBe('DT');
      expect(label.nextElementSibling).toHaveTextContent(content);
      expect(screen.queryByText('Show content')).not.toBeInTheDocument();
      // One line is a label and its text, not a scroll box with a line count.
      expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
      expect(screen.queryByText(/\(1 line\)/)).not.toBeInTheDocument();
    },
  );

  it('names each waiting card by its own change, and describes its buttons by that name', async () => {
    const [first] = runtime.tools ?? [];
    if (first === undefined) throw new Error('The fixture has a tool.');
    const write = (id: string, title: string) => ({
      ...first,
      id,
      arguments: JSON.stringify({ ...JSON.parse(first.arguments), title }),
    });
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={{ ...runtime, tools: [write('tool-a', 'Plan A'), write('tool-b', 'Plan B')] }}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    const headingA = await screen.findByRole('heading', { name: /named “Plan A”/ });
    const headingB = await screen.findByRole('heading', { name: /named “Plan B”/ });
    expect(headingA).not.toHaveTextContent('Plan B');
    const groupA = screen.getByRole('group', { name: headingA.textContent });
    const groupB = screen.getByRole('group', { name: headingB.textContent });
    // The first waiting card is where the chat scrolls to; the second is not.
    expect(groupA).toHaveAttribute('data-pet-latest-message');
    expect(groupB).not.toHaveAttribute('data-pet-latest-message');
    for (const [group, heading] of [
      [groupA, headingA],
      [groupB, headingB],
    ] as const) {
      const buttons = within(group).getAllByRole('button');
      expect(buttons.map((button) => button.textContent)).toEqual([
        'Approve request',
        'Edit',
        'Decline request',
      ]);
      for (const button of buttons) expect(button).toHaveAccessibleDescription(heading.textContent);
      expect(within(group).getByRole('button', { name: 'Edit before approving' })).toBeVisible();
    }
  });

  it('words a settled write as the request in the imperative, with the real outcome beside it', async () => {
    const settled = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        status: 'completed' as const,
        arguments: JSON.stringify({ ...JSON.parse(tool.arguments), markdown: 'Body text' }),
      })),
    };
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={settled}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
    );
    expect(
      await screen.findByText('Create a note named “Plan” at the top level of this workspace.'),
    ).toBeVisible();
    expect(screen.getByText('Done')).toBeVisible();
    expect(screen.queryByText(/I will/)).not.toBeInTheDocument();
  });

  it('describes the planned action before the permission buttons', async () => {
    show();
    const description = await screen.findByText(/I will create a note named “Plan”/);
    const approval = screen.getByRole('button', { name: 'Approve request' });
    expect(
      description.compareDocumentPosition(approval) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it.each([
    // Both read-only - list_templates and read_template are never previewed (see
    // `isAutoReadOperation`), so each is announced by its own one-line sentence rather than a
    // headline built from the preview model. Both auto-run (the default device preference), so
    // the sentence is already in its present-progressive form while the claim is in flight
    // (UX fix U3).
    [{ operation: 'list_templates', query: 'reading' }, /^Listing templates$/],
    [{ operation: 'list_templates', query: '' }, /^Listing templates$/],
    [
      { operation: 'read_template', itemId: '33333333-3333-4333-8333-333333333333' },
      /^Reading a template$/,
    ],
    [
      {
        operation: 'apply_template',
        itemId: '33333333-3333-4333-8333-333333333333',
        title: 'Reading log',
      },
      /I will create “Reading log” from the linked template at the top level/,
    ],
    [
      { operation: 'read_calendar', specJson: '{"from":"2026-10-05","to":"2026-10-11"}' },
      /^Reading the calendar from 2026-10-05 to 2026-10-11$/,
    ],
  ])('describes a template operation in plain language: %o', async (overrides, pattern) => {
    if ('operation' in overrides && overrides.operation === 'apply_template') {
      client.query.mockResolvedValue({
        templates: [{ id: '33333333-3333-4333-8333-333333333333' }],
      });
      client.execute.mockResolvedValue({
        additions: { items: 1, fields: 0, views: 0 },
        conflicts: [],
        canApply: true,
      });
    }
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={{
          ...runtime,
          tools: (runtime.tools ?? []).map((tool) => ({
            ...tool,
            arguments: JSON.stringify({
              title: '',
              markdown: '',
              itemId: '',
              parentId: '',
              query: '',
              propertiesJson: '',
              ...overrides,
            }),
          })),
        }}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    expect(await screen.findByText(pattern)).toBeInTheDocument();
  });

  it('labels a user refusal as declined rather than a failed operation', () => {
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={{
          ...runtime,
          tools:
            runtime.tools?.map((tool) => ({
              ...tool,
              status: 'failed',
              result: 'Declined by the user. Do not retry this change unless asked.',
            })) ?? [],
        }}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
    );
    // UX fix U16: the status word is no longer its own live region - the row beside it already
    // carries the announcement.
    expect(screen.getByText('Declined')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
  });

  it('does not ask again after a stale refresh or reopening an uncertain request', async () => {
    client.execute.mockRejectedValue(new Error('lost response'));
    const view = show();
    await approveRequest();
    await screen.findByRole('alert');
    view.unmount();
    show();
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    expect(screen.getByText('Approval submitted. Waiting for confirmation.')).toBeVisible();
    expect(requestOperations()).toEqual(['tool_claim', 'read']);
  });
  it('returns a declined result without performing a Nix mutation', async () => {
    const changed = vi.fn();
    const unsubscribe = onItemChildrenChanged(changed);
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...runtime,
          tools: runtime.tools?.map((tool) => ({
            ...tool,
            status: 'claimed',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Decline request' }));
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(client.execute.mock.calls[1]?.[0]).toMatchObject({
      body: {
        operation: 'tool_result',
        toolSuccess: false,
        toolResult: expect.stringContaining('Declined') as unknown,
      },
    });
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('refuses a read whose target is outside this workspace when it runs automatically', async () => {
    // A read never previews - see `isAutoReadOperation` - so the cross-workspace guard now runs
    // only at execution time, inside `runWorkspaceTool`'s own `checkItem`. It still refuses
    // before any content crosses back into a tool result.
    const scopedRuntime = {
      ...runtime,
      tools:
        runtime.tools?.map((tool) => ({
          ...tool,
          arguments: JSON.stringify({
            operation: 'read_item',
            itemId: '33333333-3333-4333-8333-333333333333',
            title: '',
            markdown: '',
            parentId: '',
            query: '',
            propertiesJson: '',
          }),
        })) ?? [],
    };
    client.query.mockResolvedValue({
      workspaceId: '44444444-4444-4444-8444-444444444444',
      title: 'Private fixture title',
    });
    client.execute.mockImplementation((endpoint: { body: { requestId: string } }) =>
      Promise.resolve({
        ...scopedRuntime,
        tools: scopedRuntime.tools.map((tool) => ({
          ...tool,
          status: 'claimed',
          claimId: endpoint.body.requestId,
        })),
      }),
    );
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={scopedRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    await waitFor(() => {
      expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
    });
    await expect(runWorkspaceToolSpy.mock.results[0]?.value as Promise<unknown>).rejects.toThrow(
      'outside this workspace',
    );
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    expect(client.invalidate).not.toHaveBeenCalled();
    // The refusal itself must never carry the private fixture's content back to the pet.
    const toolResultCall = client.execute.mock.calls.find(
      ([endpoint]) =>
        (endpoint as { body: { operation: string } }).body.operation === 'tool_result',
    );
    expect(JSON.stringify(toolResultCall?.[0])).not.toContain('Private fixture title');
  });
  it('executes once even with a double click and a stale pending snapshot', async () => {
    const changed = vi.fn();
    const unsubscribe = onItemChildrenChanged(changed);
    client.execute.mockImplementation(
      (endpoint: { operation: string; body: { operation?: string; requestId?: string } }) => {
        if (endpoint.operation === 'items.create')
          return Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' });
        return Promise.resolve({
          ...runtime,
          tools: runtime.tools?.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
          })),
        });
      },
    );
    show();
    const approval = screen.getByRole('button', { name: 'Approve request' });
    await waitFor(() => expect(approval).toBeEnabled());
    await userEvent.dblClick(approval);
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(3);
    });
    expect(
      client.execute.mock.calls.filter(
        ([endpoint]) => (endpoint as { operation: string }).operation === 'items.create',
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        workspaceId: '11111111-1111-4111-8111-111111111111',
        parentId: null,
        removedItemIds: [],
        restoredItemIds: [],
      });
    });
    expect(client.invalidate).toHaveBeenCalledWith(['items']);
    expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
    const claimRequestId = (client.execute.mock.calls[0]?.[0] as { body: { requestId: string } })
      .body.requestId;
    expect(runWorkspaceToolSpy).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-4111-8111-111111111111',
      expect.any(String),
      expect.anything(),
      {
        toolId: 'tool-1',
        claimId: claimRequestId,
        fence: JSON.stringify({ schema: { declared: [] }, views: [] }),
      },
    );
    unsubscribe();
  });

  it('automatically declines a write whose preview has problems, once, and shows a receipt', async () => {
    const invalidRuntime = {
      ...runtime,
      tools:
        runtime.tools?.map((tool) => ({
          ...tool,
          arguments: JSON.stringify({
            operation: 'create_structured',
            title: 'Board',
            itemId: '',
            parentId: '',
            markdown: '',
            query: '',
            propertiesJson: '',
            specJson: JSON.stringify({ recipe: 'drive', fields: [], inherit: true }),
          }),
        })) ?? [],
    };
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string; toolResult?: string } }) =>
        Promise.resolve({
          ...invalidRuntime,
          tools: invalidRuntime.tools.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
            ...(endpoint.body.operation === 'tool_result'
              ? { result: endpoint.body.toolResult ?? '' }
              : {}),
          })),
        }),
    );
    const onNeedsDecisionChange = vi.fn();
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={invalidRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
        onNeedsDecisionChange={onNeedsDecisionChange}
      />,
    );
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
    // A write whose preview has problems is auto-declined, never something the owner is asked to
    // decide - `needsDecision` (and this prop) must exclude it once its problems are known.
    await waitFor(() => {
      expect(onNeedsDecisionChange).toHaveBeenLastCalledWith([]);
    });
    const resultCall: unknown = client.execute.mock.calls[1]?.[0];
    expect(resultCall).toMatchObject({
      body: { operation: 'tool_result', toolSuccess: false },
    });
    const resultBody = (resultCall as { body: { toolResult: unknown } }).body;
    expect(resultBody.toolResult).toMatch(/^Declined: the design has problems\./);
    // `onChange` is a no-op here (as elsewhere in this file), so the rendered `tool` never
    // reflects the persisted result - only the receipt this component tracks itself does. The
    // richer "Sent N problems back to {pet}" wording (`WriteReceiptRow` in work-tools/activity-rows.tsx)
    // needs that persisted `tool.result`, which the live app supplies through `setRuntime`.
    expect(await screen.findByText('Declined')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
  });

  it('passes the preview fingerprint to execution and refreshes touched containers once', async () => {
    const changed = vi.fn();
    const unsubscribe = onItemChildrenChanged(changed);
    const structuredRuntime = {
      ...runtime,
      tools:
        runtime.tools?.map((tool) => ({
          ...tool,
          arguments: JSON.stringify({
            operation: 'create_structured',
            title: 'Reading log',
            itemId: '',
            parentId: '',
            markdown: '',
            query: '',
            propertiesJson: '',
            specJson: JSON.stringify({
              recipe: 'board',
              fields: [{ label: 'Status', type: 'select', options: ['To read', 'Done'] }],
              views: [{ kind: 'board', groupBy: 'Status' }],
              inherit: true,
            }),
          }),
        })) ?? [],
    };
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string } }) =>
        Promise.resolve({
          ...structuredRuntime,
          tools: structuredRuntime.tools.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
          })),
        }),
    );
    runWorkspaceToolSpy.mockResolvedValueOnce({
      text: 'created',
      readOnly: false,
      touchedParents: [
        '11111111-1111-4111-8111-111111111111',
        null,
        '33333333-3333-4333-8333-333333333333',
      ],
    });
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={structuredRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    await approveRequest();
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledTimes(2);
    });
    expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({
      fence: JSON.stringify({ schema: { declared: [] }, views: [] }),
    });
    expect(client.execute.mock.calls[0]?.[0]).toMatchObject({
      body: { operation: 'tool_claim' },
    });
    expect(client.execute.mock.calls[1]?.[0]).toMatchObject({
      body: { operation: 'tool_result' },
    });
    await waitFor(() => {
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        workspaceId: '11111111-1111-4111-8111-111111111111',
        parentId: null,
        removedItemIds: [],
        restoredItemIds: [],
      });
    });
    expect(client.invalidate).toHaveBeenCalledWith(['items']);
    unsubscribe();
  });

  describe('nix_complete_task (plan D.1)', () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const taskId = '33333333-3333-4333-8333-333333333333';
    const taskRuntime = (completed: boolean) => ({
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        arguments: JSON.stringify({
          operation: 'complete_task',
          itemId: taskId,
          parentId: '',
          title: '',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: JSON.stringify({ completed }),
        }),
      })),
    });
    const completionField = {
      key: 'completion',
      label: 'Done',
      type: 'completion',
      options: [],
      required: false,
      expression: null,
      aggregate: null,
      source: null,
    };
    function serveTask(fields: unknown[]) {
      client.query.mockImplementation((endpoint: { operation: string }) =>
        Promise.resolve(
          endpoint.operation === 'schema.get'
            ? { properties: fields, declared: [], inherit: true }
            : {
                id: taskId,
                workspaceId,
                parentId: null,
                title: 'Pay rent',
                type: 'note',
                properties: { completion: false },
              },
        ),
      );
    }

    it('shows a readable approval card and runs the approved completion through its fence', async () => {
      serveTask([completionField]);
      const pending = taskRuntime(true);
      client.execute.mockImplementation(
        (endpoint: { operation: string; body: { operation?: string; requestId?: string } }) =>
          Promise.resolve(
            endpoint.operation === 'properties.set'
              ? { id: taskId }
              : {
                  ...pending,
                  tools: pending.tools.map((tool) => ({
                    ...tool,
                    status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
                    claimId: endpoint.body.requestId ?? '',
                  })),
                },
          ),
      );
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={pending}
          workspaceId={workspaceId}
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
        />,
        { wrapper: MemoryRouter },
      );
      expect(await screen.findByText('I will mark “Pay rent” done.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Inspect target item' })).toBeInTheDocument();
      await approveRequest();
      await waitFor(() => {
        expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
      });
      expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({
        fence: `task:property:${taskId}:completion:true`,
      });
      await waitFor(() => {
        expect(client.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'properties.set',
            body: { properties: { completion: true } },
          }),
          expect.anything(),
        );
      });
      await waitFor(() => {
        expect(client.invalidate).toHaveBeenCalledWith(['workspaces', workspaceId, 'calendar']);
      });
    });

    it('sends a task without a completion field back to the pet, naming nix_add_fields', async () => {
      serveTask([]);
      const pending = taskRuntime(true);
      client.execute.mockImplementation(
        (endpoint: { body: { operation?: string; requestId?: string } }) =>
          Promise.resolve({
            ...pending,
            tools: pending.tools.map((tool) => ({
              ...tool,
              status: endpoint.body.operation === 'tool_result' ? 'failed' : 'claimed',
              claimId: endpoint.body.requestId ?? '',
            })),
          }),
      );
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={taskRuntime(true)}
          workspaceId={workspaceId}
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
        />,
        { wrapper: MemoryRouter },
      );
      await waitFor(() => {
        expect(client.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              operation: 'tool_result',
              toolSuccess: false,
              toolResult: expect.stringContaining('nix_add_fields') as unknown,
            }) as unknown,
          }),
          expect.anything(),
        );
      });
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    });
  });

  it('invalidates the template catalog after a successful template application', async () => {
    const templateId = '33333333-3333-4333-8333-333333333333';
    const applyRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        arguments: JSON.stringify({
          operation: 'apply_template',
          itemId: templateId,
          parentId: '',
          title: 'Reading log copy',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: '',
        }),
      })),
    };
    client.query.mockResolvedValue({ templates: [{ id: templateId }] });
    client.execute.mockImplementation(
      (endpoint: { operation: string; body: { operation?: string; requestId?: string } }) => {
        if (endpoint.operation === 'templates.preflight')
          return Promise.resolve({
            additions: { items: 1, fields: 2, views: 1 },
            conflicts: [],
            canApply: true,
          });
        return Promise.resolve({
          ...applyRuntime,
          tools: applyRuntime.tools.map((tool) => ({
            ...tool,
            status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
            claimId: endpoint.body.requestId,
          })),
        });
      },
    );
    runWorkspaceToolSpy.mockResolvedValueOnce({
      text: 'applied',
      readOnly: false,
      touchedParents: [null],
    });
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={applyRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    await approveRequest();
    await waitFor(() => {
      expect(client.invalidate).toHaveBeenCalledWith(['templates']);
    });
  });

  it('announces blueprint step progress and stores only outcome counts in the receipt', async () => {
    const buildId = '33333333-3333-4333-8333-333333333333';
    const buildRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        arguments: JSON.stringify({
          operation: 'build_blueprint',
          itemId: '',
          parentId: '',
          title: '',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: JSON.stringify({
            version: 1,
            title: 'Private title',
            summary: 'A small design.',
            root: { id: 'private-node', title: 'Private title' },
          }),
        }),
      })),
    };
    const fakeClient = {
      query: vi.fn((endpoint: { path?: string }) => {
        if (endpoint.path === '/items/33333333-3333-4333-8333-333333333333')
          return Promise.resolve({
            id: '33333333-3333-4333-8333-333333333333',
            workspaceId: '11111111-1111-4111-8111-111111111111',
            parentId: null,
            title: 'Pet drafts',
          });
        return Promise.reject(new Error(`Unexpected preview query: ${String(endpoint.path)}`));
      }),
      paginate: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield* [];
        },
      })),
      execute: vi.fn(
        (endpoint: { body: { operation: string; requestId: string; toolResult?: string } }) =>
          Promise.resolve({
            ...buildRuntime,
            tools: buildRuntime.tools.map((tool) => ({
              ...tool,
              status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
              claimId: endpoint.body.requestId,
            })),
          }),
      ),
      invalidate: vi.fn(),
    };
    let finishRun: (() => void) | undefined;
    runWorkspaceToolSpy.mockImplementationOnce(async (...callArgs: unknown[]) => {
      const options = callArgs[4] as { onProgress?: (completed: number, total: number) => void };
      options.onProgress?.(1, 2);
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return {
        text: JSON.stringify({
          rootId: buildId,
          complete: true,
          ledger: [
            { nodeId: 'private-node', step: 'createItem', status: 'done', itemId: buildId },
            { nodeId: '$sandbox', step: 'ensureSandbox', status: 'done' },
          ],
        }),
        readOnly: false,
        touchedParents: [null],
      };
    });
    render(
      <MemoryRouter>
        <PetWorkTools
          client={fakeClient as unknown as NixClient}
          runtime={buildRuntime}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
        />
      </MemoryRouter>,
    );
    const approveButton = await screen.findByRole('button', { name: 'Approve request' });
    await waitFor(() => {
      expect(approveButton).toBeEnabled();
    });
    await userEvent.click(approveButton);
    await waitFor(() => {
      expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('Building 1 of 2...')).toBeInTheDocument();
    if (finishRun) finishRun();
    await waitFor(() => {
      expect(fakeClient.execute).toHaveBeenCalledTimes(2);
    });
    expect(Object.values(sessionStorage)).not.toContain('Private title');
    const storedReceipts = Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key));
    expect(storedReceipts).toContain('Built 2 of 2.');
    expect(storedReceipts.join(' ')).not.toContain('Private title');
  });

  it('offers confirmed cleanup for an incomplete blueprint result', async () => {
    const buildId = '33333333-3333-4333-8333-333333333333';
    const incompleteRuntime = {
      ...runtime,
      tools: (runtime.tools ?? []).map((tool) => ({
        ...tool,
        status: 'completed' as const,
        arguments: JSON.stringify({
          operation: 'build_blueprint',
          itemId: '',
          parentId: '',
          title: '',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: JSON.stringify({
            version: 1,
            title: 'Plan',
            summary: 'A small design.',
            root: { id: 'plan', title: 'Plan' },
          }),
        }),
        result: JSON.stringify({
          rootId: buildId,
          complete: false,
          ledger: [
            { nodeId: 'plan', status: 'done' },
            { nodeId: 'task', status: 'failed' },
          ],
        }),
      })),
    };
    client.query.mockResolvedValue({
      id: buildId,
      workspaceId: '11111111-1111-4111-8111-111111111111',
      parentId: null,
      title: 'Plan',
    });
    client.execute.mockResolvedValue(incompleteRuntime);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <MemoryRouter>
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={incompleteRuntime}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('Stopped after 1 of 2. The draft is incomplete.'),
    ).toBeInTheDocument();
    // A build that stopped part way never reads "Done".
    expect(screen.getByText('Incomplete')).toBeVisible();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move draft to trash' }));
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'items.delete' }),
        expect.anything(),
      );
    });
    expect(confirmSpy).toHaveBeenCalledWith(
      'Move the incomplete draft to Trash? It can be restored later.',
    );
    expect(screen.getByText('Incomplete draft moved to Trash.')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  describe('security fix S1: nothing a pending write would store is hidden or truncated', () => {
    function showWrite(
      operation: string,
      specJson: string,
      overrides: Record<string, string> = {},
    ) {
      return render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={{
            ...runtime,
            tools: (runtime.tools ?? []).map((tool) => ({
              ...tool,
              arguments: JSON.stringify({
                operation,
                title: '',
                markdown: '',
                itemId: '',
                parentId: '',
                query: '',
                propertiesJson: '',
                specJson,
                ...overrides,
              }),
            })),
          }}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
        />,
        { wrapper: MemoryRouter },
      );
    }

    it('shows a create_entries entry body past its 200-character summary length', async () => {
      const body = 'y'.repeat(250);
      showWrite(
        'create_entries',
        JSON.stringify({ entries: [{ title: 'Task one', markdown: body }] }),
        { parentId: '33333333-3333-4333-8333-333333333333' },
      );
      const region = await screen.findByText(body);
      expect(region).toBeVisible();
      expect(body[200]).toBeDefined();
    });

    it('shows an add_fields field help string', async () => {
      const help = 'h'.repeat(190);
      showWrite(
        'add_fields',
        JSON.stringify({ fields: [{ label: 'Status', type: 'text', help }] }),
        {
          itemId: '33333333-3333-4333-8333-333333333333',
        },
      );
      expect(await screen.findByText(help)).toBeVisible();
    });

    it('shows a save_as_template description', async () => {
      const description = 'd'.repeat(390);
      showWrite('save_as_template', JSON.stringify({ description }), {
        itemId: '33333333-3333-4333-8333-333333333333',
        title: 'Job hunt',
      });
      expect(await screen.findByText(description)).toBeVisible();
    });

    it('shows an apply_template input value', async () => {
      const value = 'v'.repeat(150);
      showWrite('apply_template', JSON.stringify({ inputs: { start_date: value } }), {
        itemId: '33333333-3333-4333-8333-333333333333',
        title: 'Reading log copy',
      });
      expect(await screen.findByText(value)).toBeVisible();
    });

    it('shows an edit_form confirmation message', async () => {
      const message = 'm'.repeat(250);
      showWrite(
        'edit_form',
        JSON.stringify({
          viewId: 'v1',
          form: {
            pages: [{ title: 'Page 1', blocks: [{ field: 'status' }] }],
            confirmation: { title: 'Done', message },
          },
        }),
        { itemId: '33333333-3333-4333-8333-333333333333' },
      );
      expect(await screen.findByText(message)).toBeVisible();
    });

    it('shows a build_blueprint node body', async () => {
      const body = 'b'.repeat(220);
      showWrite(
        'build_blueprint',
        JSON.stringify({
          version: 1,
          title: 'Design draft',
          summary: 'A small design.',
          root: { id: 'plan', title: 'Plan', markdown: body },
        }),
      );
      expect(await screen.findByText(body)).toBeVisible();
    });

    it('shows a one-line string exactly, inner spaces and all, beside its label', async () => {
      const exact = 'Pay  rent   on  the  1st';
      showWrite(
        'build_blueprint',
        JSON.stringify({
          version: 1,
          title: 'Design draft',
          summary: 'A small design.',
          root: { id: 'plan', title: 'Plan', markdown: exact },
        }),
      );
      const text = await screen.findByText((_, element) => element?.textContent === exact);
      expect(text.tagName).toBe('DD');
      expect(text.className).toContain('whitespace-pre-wrap');
    });

    it('gives every text region a distinct name when labels repeat', async () => {
      showWrite(
        'build_blueprint',
        JSON.stringify({
          version: 1,
          title: 'Design draft',
          summary: 'A small design.',
          root: {
            id: 'plan',
            title: 'Plan',
            markdown: 'First body\nline two',
            children: [{ id: 'week', title: 'Week', markdown: 'Second body\nline two' }],
          },
        }),
      );
      await screen.findByText(/Second body/);
      const names = screen
        .getAllByRole('group')
        .filter((group) => group.hasAttribute('aria-label'))
        .map((group) => group.getAttribute('aria-label'));
      expect(names.length).toBeGreaterThan(1);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  it('retries a second auto-run read whose first attempt found the claim lock held (security fix S3)', async () => {
    const dualRuntime = {
      ...runtime,
      tools: [
        {
          id: 'read-1',
          arguments: JSON.stringify({
            operation: 'search',
            query: 'alpha',
            title: '',
            markdown: '',
            itemId: '',
            parentId: '',
            propertiesJson: '',
          }),
          status: 'pending' as const,
          result: '',
          claimId: '',
        },
        {
          id: 'read-2',
          arguments: JSON.stringify({
            operation: 'search',
            query: 'beta',
            title: '',
            markdown: '',
            itemId: '',
            parentId: '',
            propertiesJson: '',
          }),
          status: 'pending' as const,
          result: '',
          claimId: '',
        },
      ],
    };
    client.execute.mockImplementation(
      (endpoint: { body: { operation: string; requestId: string; toolId: string } }) =>
        Promise.resolve({
          ...dualRuntime,
          tools: dualRuntime.tools.map((tool) =>
            tool.id === endpoint.body.toolId
              ? {
                  ...tool,
                  status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
                  claimId: endpoint.body.requestId,
                }
              : tool,
          ),
        }),
    );
    runWorkspaceToolSpy.mockResolvedValue({ text: 'ok', readOnly: true, touchedParents: [] });
    render(
      <PetWorkTools
        client={client as unknown as NixClient}
        runtime={dualRuntime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    // Without the fix, the second read's auto-run key is set before its `onResolve` call even
    // returns, so once the first read holds the claim lock, the second is never retried.
    await waitFor(() => {
      expect(runWorkspaceToolSpy).toHaveBeenCalledTimes(2);
    });
  });
  describe('apply without asking (lane F)', () => {
    const structuredArguments = JSON.stringify({
      operation: 'create_structured',
      title: 'Reading log',
      itemId: '',
      parentId: '',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: JSON.stringify({
        recipe: 'board',
        fields: [{ label: 'Status', type: 'select', options: ['To read', 'Done'] }],
        views: [{ kind: 'board', groupBy: 'Status' }],
        inherit: true,
      }),
    });
    function withArguments(toolArguments: string) {
      return {
        ...runtime,
        tools: (runtime.tools ?? []).map((tool) => ({ ...tool, arguments: toolArguments })),
      };
    }
    /** The live app feeds every runtime response back through `setRuntime`; this wrapper does
     * the same so a receipt can reflect the persisted `tool.status`. */
    function Live({
      initial,
      onNeedsDecisionChange,
      exempt = [],
    }: {
      readonly initial: typeof runtime;
      readonly onNeedsDecisionChange: (ids: readonly string[]) => void;
      readonly exempt?: readonly string[];
    }): ReactElement {
      const [live, setLive] = useState(initial);
      return (
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={live}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          petName="Cat"
          onChange={setLive}
          onNeedsDecisionChange={onNeedsDecisionChange}
          applyWithoutAsking
          applyExemptToolIds={exempt}
        />
      );
    }
    /** Every runtime call flips the addressed tool to claimed, then completed with its result. */
    function completeEachCall(base: typeof runtime) {
      client.execute.mockImplementation(
        (endpoint: { body: { operation: string; requestId: string; toolId: string } }) =>
          Promise.resolve({
            ...base,
            tools: base.tools?.map((tool) =>
              tool.id === endpoint.body.toolId
                ? {
                    ...tool,
                    status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
                    claimId: endpoint.body.requestId,
                    result: endpoint.body.operation === 'tool_result' ? 'created' : '',
                  }
                : tool,
            ),
          }),
      );
    }

    it('runs a clean write on its own with the preview fingerprint and says so on the receipt, also after a remount', async () => {
      const structuredRuntime = withArguments(structuredArguments);
      completeEachCall(structuredRuntime);
      runWorkspaceToolSpy.mockResolvedValueOnce({
        text: 'created',
        readOnly: false,
        touchedParents: [],
      });
      const onNeedsDecisionChange = vi.fn();
      const view = render(
        <Live initial={structuredRuntime} onNeedsDecisionChange={onNeedsDecisionChange} />,
        { wrapper: MemoryRouter },
      );
      await waitFor(() => {
        expect(client.execute).toHaveBeenCalledTimes(2);
      });
      // Same path as a click: claim first, then execute behind the preview's own fence.
      expect(client.execute.mock.calls[0]?.[0]).toMatchObject({
        body: { operation: 'tool_claim' },
      });
      expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({
        fence: JSON.stringify({ schema: { declared: [] }, views: [] }),
      });
      expect(client.execute.mock.calls[1]?.[0]).toMatchObject({
        body: { operation: 'tool_result', toolSuccess: true },
      });
      // Never something the owner was asked to decide.
      expect(onNeedsDecisionChange).toHaveBeenLastCalledWith([]);
      expect(await screen.findByText('Done without asking')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
      // Never a receipt that claims the owner approved it, at any point.
      expect(screen.queryByText(/Approval submitted/)).not.toBeInTheDocument();
      // What ran stays readable afterwards: the preview and the text it stored.
      await userEvent.click(screen.getByText('What was applied'));
      expect(screen.getByText('Reading log')).toBeVisible();
      // The wording is stored with the receipt, so reopening the panel keeps it.
      view.unmount();
      const completed = {
        ...structuredRuntime,
        tools: structuredRuntime.tools.map((tool) => ({
          ...tool,
          status: 'completed' as const,
          result: 'created',
        })),
      };
      render(<Live initial={completed} onNeedsDecisionChange={vi.fn()} />, {
        wrapper: MemoryRouter,
      });
      expect(await screen.findByText('Done without asking')).toBeVisible();
    });

    const lockedNote = 'This one waits for you: earlier reads need your review before changes.';
    const claimedTools = () =>
      client.execute.mock.calls
        .map((call) => (call[0] as { body?: { operation?: string; toolId?: string } }).body)
        .filter((body) => body?.operation === 'tool_claim')
        .map((body) => body?.toolId);

    it.each([
      [true, 'waits'],
      [false, 'runs'],
    ])(
      'reports a read under a lock (%s) with its result, and the next write %s on the server mark',
      async (locked, outcome) => {
        const itemId = '33333333-3333-4333-8333-333333333333';
        const read = {
          ...(runtime.tools ?? [])[0],
          id: 'read-1',
          arguments: JSON.stringify({
            operation: 'read_item',
            itemId,
            parentId: '',
            title: '',
            markdown: '',
            query: '',
            propertiesJson: '',
          }),
        };
        const write = {
          ...(runtime.tools ?? [])[0],
          id: 'write-1',
          arguments: structuredArguments,
        };
        const turn = { ...runtime, tools: [read, write] } as typeof runtime;
        // The worker marks the conversation from the tool result's own flag; this stands in for it.
        let marked = false;
        client.execute.mockImplementation(
          (endpoint: {
            body: {
              operation: string;
              requestId: string;
              toolId: string;
              toolLockedContent?: boolean;
            };
          }) => {
            if (endpoint.body.toolLockedContent === true) marked = true;
            return Promise.resolve({
              ...turn,
              lockedRead: marked,
              tools: turn.tools?.map((tool) =>
                tool.id === endpoint.body.toolId
                  ? {
                      ...tool,
                      status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
                      claimId: endpoint.body.requestId,
                    }
                  : tool,
              ),
            });
          },
        );
        // The real executor reads the item, then its lock state, exactly as in the app.
        client.query.mockImplementation((endpoint: { operation: string }) =>
          Promise.resolve(
            endpoint.operation === 'locks.get'
              ? {
                  locked,
                  unlockedUntil: locked ? '2030-01-01T00:00:00+00:00' : null,
                  lockItemId: locked ? itemId : null,
                  selfLocked: locked,
                }
              : {
                  id: itemId,
                  workspaceId: '11111111-1111-4111-8111-111111111111',
                  parentId: null,
                  title: 'Diary',
                  type: 'note',
                  properties: {},
                },
          ),
        );
        const onNeedsDecisionChange = vi.fn();
        render(<Live initial={turn} onNeedsDecisionChange={onNeedsDecisionChange} />, {
          wrapper: MemoryRouter,
        });
        await waitFor(() => {
          expect(claimedTools()).toContain('read-1');
        });
        await waitFor(() => {
          expect(client.execute).toHaveBeenCalledWith(
            expect.objectContaining({
              body: expect.objectContaining({
                operation: 'tool_result',
                toolId: 'read-1',
                toolLockedContent: locked,
              }) as unknown,
            }),
            expect.anything(),
          );
        });
        if (outcome === 'waits') {
          expect(await screen.findByText(lockedNote)).toBeVisible();
          await waitFor(() => {
            expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['write-1']);
          });
          expect(claimedTools()).not.toContain('write-1');
        } else {
          await waitFor(() => {
            expect(claimedTools()).toContain('write-1');
          });
          expect(screen.queryByText(lockedNote)).not.toBeInTheDocument();
        }
      },
    );

    it('holds a write in a later turn, in every open panel, while the server says the thread read locked content', async () => {
      // A later turn: the read is gone from the tool list, only the server's mark remains. Two
      // instances stand in for two tabs; neither keeps any local memory of the read.
      const laterTurn = {
        ...withArguments(structuredArguments),
        lockedRead: true,
      } as typeof runtime;
      const first = vi.fn();
      const second = vi.fn();
      render(
        <>
          <Live initial={laterTurn} onNeedsDecisionChange={first} />
          <Live initial={laterTurn} onNeedsDecisionChange={second} />
        </>,
        { wrapper: MemoryRouter },
      );
      expect(await screen.findAllByText(lockedNote)).toHaveLength(2);
      await waitFor(() => {
        expect(first).toHaveBeenLastCalledWith(['tool-1']);
        expect(second).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(client.execute).not.toHaveBeenCalled();
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
    });

    it('never completes an occurrence of a repeating task without asking', async () => {
      const taskId = '33333333-3333-4333-8333-333333333333';
      const now = new Date();
      const today = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const field = (key: string, type: string) => ({
        key,
        label: key,
        type,
        options: [],
        required: false,
        expression: null,
        aggregate: null,
        source: null,
      });
      client.query.mockImplementation((endpoint: { operation: string }) =>
        Promise.resolve(
          endpoint.operation === 'schema.get'
            ? {
                properties: [field('due_date', 'due_date'), field('completion', 'completion')],
                declared: [],
                inherit: true,
              }
            : endpoint.operation === 'locks.get'
              ? { locked: false, unlockedUntil: null, lockItemId: null, selfLocked: false }
              : endpoint.operation === 'workspaceCalendar.get'
                ? {
                    workspaceId: '11111111-1111-4111-8111-111111111111',
                    from: today,
                    to: today,
                    entries: [
                      {
                        itemId: taskId,
                        title: 'Water plants',
                        containerId: taskId,
                        containerTitle: 'Tasks',
                        dateProperty: 'due_date',
                        value: today,
                        kind: 'date',
                        generated: true,
                        completed: false,
                        endProperty: null,
                        endValue: null,
                      },
                    ],
                    unplaceable: [],
                    entryLimit: 2000,
                    entriesTruncated: false,
                    seriesTruncated: false,
                  }
                : {
                    id: taskId,
                    workspaceId: '11111111-1111-4111-8111-111111111111',
                    parentId: null,
                    title: 'Water plants',
                    type: 'note',
                    properties: { due_date: '2026-01-01' },
                  },
        ),
      );
      const task = withArguments(
        JSON.stringify({
          operation: 'complete_task',
          itemId: taskId,
          parentId: '',
          title: '',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: '{"completed":true}',
        }),
      );
      const onNeedsDecisionChange = vi.fn();
      render(<Live initial={task} onNeedsDecisionChange={onNeedsDecisionChange} />, {
        wrapper: MemoryRouter,
      });
      expect(
        await screen.findByText(
          "This one waits for you: completing a repeating task's occurrence cannot be undone.",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(/occurrence of the repeating task “Water plants” done/),
      ).toBeVisible();
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
      expect(client.execute).not.toHaveBeenCalled();
    });

    it('runs several clean writes from one turn once each, in order, each behind its own claim', async () => {
      const first = { ...(runtime.tools ?? [])[0], id: 'tool-1', arguments: structuredArguments };
      const second = { ...first, id: 'tool-2' };
      const twoRuntime = { ...runtime, tools: [first, second] } as typeof runtime;
      completeEachCall(twoRuntime);
      runWorkspaceToolSpy.mockResolvedValue({
        text: 'created',
        readOnly: false,
        touchedParents: [],
      });
      render(<Live initial={twoRuntime} onNeedsDecisionChange={vi.fn()} />, {
        wrapper: MemoryRouter,
      });
      await waitFor(() => {
        expect(client.execute).toHaveBeenCalledTimes(4);
      });
      const operations = client.execute.mock.calls.map(
        (call) => (call[0] as { body: { operation: string; toolId: string } }).body,
      );
      expect(operations.map((body) => `${body.operation}:${body.toolId}`)).toEqual([
        'tool_claim:tool-1',
        'tool_result:tool-1',
        'tool_claim:tool-2',
        'tool_result:tool-2',
      ]);
      expect(runWorkspaceToolSpy).toHaveBeenCalledTimes(2);
      expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({
        toolId: 'tool-1',
        fence: JSON.stringify({ schema: { declared: [] }, views: [] }),
      });
      expect(runWorkspaceToolSpy.mock.calls[1]?.[4]).toMatchObject({
        toolId: 'tool-2',
        fence: JSON.stringify({ schema: { declared: [] }, views: [] }),
      });
    });

    it('leaves a write that was already waiting when the switch went on to the owner', async () => {
      const structuredRuntime = withArguments(structuredArguments);
      const onNeedsDecisionChange = vi.fn();
      render(
        <Live
          initial={structuredRuntime}
          onNeedsDecisionChange={onNeedsDecisionChange}
          exempt={['tool-1']}
        />,
        { wrapper: MemoryRouter },
      );
      expect(await screen.findByRole('button', { name: 'Approve request' })).toBeEnabled();
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(client.execute).not.toHaveBeenCalled();
    });

    it('keeps a write that would store a link to another host waiting for a click', async () => {
      const linkRuntime = withArguments(
        JSON.stringify({
          operation: 'create_note',
          title: 'Plan',
          markdown: 'See ![](https://example.test/p?d=secret)',
          itemId: '',
          parentId: '',
          query: '',
          propertiesJson: '',
        }),
      );
      const onNeedsDecisionChange = vi.fn();
      render(<Live initial={linkRuntime} onNeedsDecisionChange={onNeedsDecisionChange} />, {
        wrapper: MemoryRouter,
      });
      expect(await screen.findByRole('button', { name: 'Approve request' })).toBeEnabled();
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(client.execute).not.toHaveBeenCalled();
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
    });

    it('keeps a trash request waiting for a click', async () => {
      const itemId = '33333333-3333-4333-8333-333333333333';
      client.query.mockResolvedValue({
        id: itemId,
        workspaceId: '11111111-1111-4111-8111-111111111111',
        parentId: null,
        title: 'Old plan',
        type: 'note',
        hasChildren: false,
        properties: {},
      });
      const trashRuntime = withArguments(
        JSON.stringify({
          operation: 'trash_item',
          itemId,
          parentId: '',
          title: '',
          markdown: '',
          query: '',
          propertiesJson: '',
        }),
      );
      const onNeedsDecisionChange = vi.fn();
      render(<Live initial={trashRuntime} onNeedsDecisionChange={onNeedsDecisionChange} />, {
        wrapper: MemoryRouter,
      });
      expect(await screen.findByRole('button', { name: 'Approve request' })).toBeInTheDocument();
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(client.execute).not.toHaveBeenCalled();
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
    });

    it('never runs a write whose preview failed to load, and still counts it as needing a decision', async () => {
      client.query.mockRejectedValue(new Error('offline'));
      const renameRuntime = withArguments(
        JSON.stringify({
          operation: 'rename_item',
          itemId: '33333333-3333-4333-8333-333333333333',
          parentId: '',
          title: 'New name',
          markdown: '',
          query: '',
          propertiesJson: '',
        }),
      );
      const onNeedsDecisionChange = vi.fn();
      render(<Live initial={renameRuntime} onNeedsDecisionChange={onNeedsDecisionChange} />, {
        wrapper: MemoryRouter,
      });
      expect(
        await screen.findByText(
          'The preview could not be loaded. Decline and ask the pet to try again.',
        ),
      ).toBeVisible();
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(client.execute).not.toHaveBeenCalled();
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
    });
  });

  describe('note body edits (lane C)', () => {
    const noteId = '33333333-3333-4333-8333-333333333333';
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    function editRuntime(fields: { operation: string; query: string; markdown: string }) {
      return {
        ...runtime,
        tools: (runtime.tools ?? []).map((tool) => ({
          ...tool,
          arguments: JSON.stringify({
            itemId: noteId,
            parentId: '',
            title: '',
            propertiesJson: '',
            specJson: '',
            ...fields,
          }),
        })),
      };
    }
    /** Serves `note` (Markdown, or a document when the fixture needs formatting Markdown cannot
     * spell) as the note's whole collab history and the note item itself. */
    function serveNote(note: string | Record<string, unknown>, locked = false) {
      let content: unknown;
      if (typeof note === 'string') {
        const parsed = markdownToDocument(note);
        if (!parsed.ok) throw new Error('fixture Markdown is invalid');
        content = parsed.doc;
      } else {
        content = note;
      }
      const doc = new Y.Doc();
      prosemirrorJSONToYXmlFragment(nixSchema, content, doc.getXmlFragment('default'));
      const update = btoa(
        Array.from(Y.encodeStateAsUpdate(doc), (byte) => String.fromCharCode(byte)).join(''),
      );
      doc.destroy();
      client.query.mockImplementation((endpoint: { operation: string }) => {
        if (endpoint.operation === 'companion.body.read')
          return Promise.resolve({ hasMore: false, updates: [{ seq: '1', update }] });
        if (endpoint.operation === 'locks.get')
          return Promise.resolve({
            locked,
            unlockedUntil: locked ? '2030-01-01T00:00:00+00:00' : null,
            lockItemId: locked ? noteId : null,
            selfLocked: locked,
          });
        if (endpoint.operation === 'items.get')
          return Promise.resolve({
            id: noteId,
            workspaceId,
            parentId: null,
            title: 'Trip',
            type: 'note',
          });
        throw new Error(`Unexpected preview query: ${endpoint.operation}`);
      });
    }
    function claimThenComplete(base: typeof runtime) {
      client.execute.mockImplementation(
        (endpoint: {
          body: {
            operation: string;
            requestId: string;
            toolSuccess?: boolean;
            toolResult?: string;
          };
        }) =>
          Promise.resolve({
            ...base,
            tools: base.tools?.map((tool) => ({
              ...tool,
              status:
                endpoint.body.operation !== 'tool_result'
                  ? 'claimed'
                  : endpoint.body.toolSuccess
                    ? 'completed'
                    : 'failed',
              claimId: endpoint.body.requestId,
              result: endpoint.body.toolResult ?? '',
            })),
          }),
      );
    }

    function LiveTools({
      initial,
      applyWithoutAsking = false,
      onNeedsDecisionChange,
    }: {
      readonly initial: typeof runtime;
      readonly applyWithoutAsking?: boolean;
      readonly onNeedsDecisionChange?: (ids: readonly string[]) => void;
    }): ReactElement {
      const [live, setLive] = useState(initial);
      return (
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={live}
          workspaceId={workspaceId}
          petId="22222222-2222-4222-8222-222222222222"
          petName="Cat"
          onChange={setLive}
          applyWithoutAsking={applyWithoutAsking}
          {...(onNeedsDecisionChange ? { onNeedsDecisionChange } : {})}
        />
      );
    }

    it('shows the section before and after, then runs behind the preview fingerprint', async () => {
      serveNote('# Trip\n\n## Budget\n\nTotal is 400.\n\n## Notes\n\nFirst note.');
      const sectionRuntime = editRuntime({
        operation: 'replace_section',
        query: 'Budget',
        markdown: 'Total is 450.\n\n- Venue',
      });
      claimThenComplete(sectionRuntime);
      runWorkspaceToolSpy.mockResolvedValueOnce({
        text: '{"replaced":true}',
        readOnly: false,
        touchedParents: [],
      });
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={sectionRuntime}
          workspaceId={workspaceId}
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
        />,
        { wrapper: MemoryRouter },
      );
      expect(
        await screen.findByText(
          'I will rewrite the section “Budget” in the linked note. The rest of the note stays as it is.',
        ),
      ).toBeVisible();
      expect(
        screen.getByRole('region', { name: 'Text now, Section “Budget” in Trip' }),
      ).toHaveTextContent('## Budget removed: Total is 400.');
      expect(
        screen.getByRole('region', { name: 'Text after this change, Section “Budget” in Trip' }),
      ).toHaveTextContent('## Budget added: Total is 450. added: - Venue');
      expect(screen.queryByText(/Removes 1 block/)).not.toBeInTheDocument();
      // The comparison already carries the new text; it is not listed a second time.
      expect(screen.queryByRole('region', { name: /New section text/ })).not.toBeInTheDocument();
      await approveRequest();
      await waitFor(() => {
        expect(client.execute).toHaveBeenCalledTimes(2);
      });
      expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({
        fence: JSON.stringify(['section', '## Budget\n\nTotal is 400.']),
      });
    });

    it('sends a heading it cannot place back to the pet with the headings it found', async () => {
      serveNote('# Trip\n\n## Budget\n\nTotal is 400.');
      const missingRuntime = editRuntime({
        operation: 'replace_section',
        query: 'Itinerary',
        markdown: 'Day one.',
      });
      claimThenComplete(missingRuntime);
      render(<LiveTools initial={missingRuntime} />, { wrapper: MemoryRouter });
      await waitFor(() => {
        expect(client.execute).toHaveBeenCalledTimes(2);
      });
      expect(client.execute.mock.calls[1]?.[0]).toMatchObject({
        body: {
          operation: 'tool_result',
          toolSuccess: false,
          toolResult: expect.stringContaining(
            'Headings in this note: "Trip", "Budget".',
          ) as unknown,
          toolLockedContent: false,
        },
      });
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
      // The owner reads the problem without tool names; the model got its own text.
      expect(await screen.findByText('Sent 1 problem back to Cat')).toBeVisible();
      await userEvent.click(screen.getByText('Show problems'));
      expect(
        screen.getByText('There is no heading “Itinerary” in this note, so nothing was edited.'),
      ).toBeVisible();
    });

    it('runs a clean passage edit without asking when the switch is on', async () => {
      serveNote('Meet at teh station.');
      const passageRuntime = editRuntime({
        operation: 'replace_passage',
        query: 'teh',
        markdown: 'the',
      });
      claimThenComplete(passageRuntime);
      runWorkspaceToolSpy.mockResolvedValueOnce({
        text: '{"replaced":true}',
        readOnly: false,
        touchedParents: [],
      });
      const onNeedsDecisionChange = vi.fn();
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={passageRuntime}
          workspaceId={workspaceId}
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
          onNeedsDecisionChange={onNeedsDecisionChange}
          applyWithoutAsking
        />,
        { wrapper: MemoryRouter },
      );
      await waitFor(() => {
        expect(runWorkspaceToolSpy).toHaveBeenCalledOnce();
      });
      expect(runWorkspaceToolSpy.mock.calls[0]?.[4]).toMatchObject({
        fence: JSON.stringify(['passage', 'Meet at teh station.']),
      });
      expect(await screen.findByText('Done without asking')).toBeVisible();
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith([]);
      });
    });

    it('holds a clean passage edit while the conversation has read locked content', async () => {
      serveNote('Meet at teh station.');
      const passageRuntime = {
        ...editRuntime({ operation: 'replace_passage', query: 'teh', markdown: 'the' }),
        lockedRead: true,
      } as typeof runtime;
      const onNeedsDecisionChange = vi.fn();
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={passageRuntime}
          workspaceId={workspaceId}
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
          onNeedsDecisionChange={onNeedsDecisionChange}
          applyWithoutAsking
        />,
        { wrapper: MemoryRouter },
      );
      // The preview is clean and loads, yet the edit waits and says why.
      expect(await screen.findByRole('region', { name: /^Text after this change/ })).toBeVisible();
      expect(
        screen.getByText('This one waits for you: earlier reads need your review before changes.'),
      ).toBeVisible();
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(screen.getByRole('button', { name: 'Approve request' })).toBeEnabled();
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
      expect(client.execute).not.toHaveBeenCalled();
    });

    it('reports a refused edit to a locked note as locked content, since its problems quote the note', async () => {
      serveNote('# Diary\n\n## Private\n\nNothing here.', true);
      const missingRuntime = editRuntime({
        operation: 'replace_section',
        query: 'Itinerary',
        markdown: 'Day one.',
      });
      claimThenComplete(missingRuntime);
      render(<LiveTools initial={missingRuntime} />, { wrapper: MemoryRouter });
      await waitFor(() => {
        expect(client.execute).toHaveBeenCalledTimes(2);
      });
      expect(client.execute.mock.calls[1]?.[0]).toMatchObject({
        body: {
          operation: 'tool_result',
          toolSuccess: false,
          toolLockedContent: true,
          toolResult: expect.stringContaining('"Private"') as unknown,
        },
      });
    });

    it('waits for the owner when the edit would drop formatting Markdown cannot keep', async () => {
      serveNote({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: 'center' },
            content: [{ type: 'text', text: 'Centred line' }],
          },
        ],
      });
      const passageRuntime = editRuntime({
        operation: 'replace_passage',
        query: 'Centred',
        markdown: 'Centered',
      });
      const onNeedsDecisionChange = vi.fn();
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={passageRuntime}
          workspaceId={workspaceId}
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
          onNeedsDecisionChange={onNeedsDecisionChange}
          applyWithoutAsking
        />,
        { wrapper: MemoryRouter },
      );
      expect(
        await screen.findByRole('region', { name: /^Text after this change/ }),
      ).toHaveTextContent('Centadded: ered line');
      expect(
        screen.getByText(
          'This one waits for you: approving it removes formatting this edit can’t keep (see below).',
        ),
      ).toBeVisible();
      expect(
        screen.getByText('This paragraph: Its text alignment goes back to the default.'),
      ).toBeVisible();
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(screen.getByRole('button', { name: 'Approve request' })).toBeEnabled();
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
      expect(client.execute).not.toHaveBeenCalled();
    });

    it('waits for the owner when the edited text would form a link to another host', async () => {
      serveNote('Fetch http:XX//evil.example/a now.');
      const passageRuntime = editRuntime({
        operation: 'replace_passage',
        query: 'XX',
        markdown: '',
      });
      const onNeedsDecisionChange = vi.fn();
      render(
        <PetWorkTools
          client={client as unknown as NixClient}
          runtime={passageRuntime}
          workspaceId={workspaceId}
          petId="22222222-2222-4222-8222-222222222222"
          onChange={vi.fn()}
          onNeedsDecisionChange={onNeedsDecisionChange}
          applyWithoutAsking
        />,
        { wrapper: MemoryRouter },
      );
      expect(
        await screen.findByRole('region', { name: /^Text after this change/ }),
      ).toHaveTextContent('http://evil.example/a');
      expect(
        screen.getByText('This one waits for you: it adds a link to another site.'),
      ).toBeVisible();
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(screen.getByRole('button', { name: 'Approve request' })).toBeEnabled();
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
      expect(client.execute).not.toHaveBeenCalled();
    });

    it('keeps the comparison on the receipt of an edit the owner approved, with the way back', async () => {
      serveNote('# Trip\n\n## Budget\n\nTotal is 400.');
      const sectionRuntime = editRuntime({
        operation: 'replace_section',
        query: 'Budget',
        markdown: 'Total is 450.',
      });
      claimThenComplete(sectionRuntime);
      runWorkspaceToolSpy.mockResolvedValueOnce({
        text: '{"replaced":true}',
        readOnly: false,
        touchedParents: [],
      });
      render(<LiveTools initial={sectionRuntime} />, { wrapper: MemoryRouter });
      await approveRequest();
      expect(await screen.findByText('Done')).toBeVisible();
      // The receipt names the edit, never the preview's "I will..." beside "Done".
      expect(screen.getByText('Edit to the section “Budget” in the linked note')).toBeVisible();
      await userEvent.click(screen.getByText('What was applied'));
      expect(
        screen.getByRole('region', { name: 'Text before, Section “Budget” in Trip' }),
      ).toHaveTextContent('Total is 400.');
      expect(
        screen.getByRole('region', { name: 'Text after, Section “Budget” in Trip' }),
      ).toHaveTextContent('Total is 450.');
      expect(
        screen.getByText(
          'You can restore the earlier text: open the note and choose History from its menu.',
        ),
      ).toBeVisible();
      expect(screen.getByRole('link', { name: 'Open the note' })).toHaveAttribute(
        'href',
        `/w/${workspaceId}?item=${noteId}`,
      );
    });

    it('says an approved edit refused before it changed anything was not run, in the owner’s words', async () => {
      serveNote('Meet at teh station.');
      const passageRuntime = editRuntime({
        operation: 'replace_passage',
        query: 'teh',
        markdown: 'the',
      });
      client.execute.mockImplementation(
        (endpoint: { body: { operation: string; requestId: string; toolResult?: string } }) =>
          Promise.resolve({
            ...passageRuntime,
            tools: passageRuntime.tools.map((tool) => ({
              ...tool,
              status: endpoint.body.operation === 'tool_result' ? 'failed' : 'claimed',
              claimId: endpoint.body.requestId,
              result: endpoint.body.toolResult ?? '',
            })),
          }),
      );
      const { WorkspaceToolRefusal } = await import('@nix/companion/tool-args');
      runWorkspaceToolSpy.mockRejectedValueOnce(
        new WorkspaceToolRefusal(
          'The note changed since you approved this. Read it again before editing.',
          'The note changed after you approved this, so nothing was edited.',
        ),
      );
      render(<LiveTools initial={passageRuntime} />, { wrapper: MemoryRouter });
      await approveRequest();
      expect(await screen.findByText('Not run - nothing changed')).toBeVisible();
      expect(client.execute.mock.calls[1]?.[0]).toMatchObject({
        body: {
          operation: 'tool_result',
          toolSuccess: false,
          toolResult: 'The note changed since you approved this. Read it again before editing.',
        },
      });
      await userEvent.click(screen.getByText('Why it did not run'));
      expect(
        screen.getByText('The note changed after you approved this, so nothing was edited.'),
      ).toBeVisible();
      expect(screen.queryByText(/Read it again before editing/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Didn't finish/)).not.toBeInTheDocument();
    });

    it('counts a body edit as needing a decision until its preview has loaded', async () => {
      client.query.mockImplementation(() => new Promise(() => undefined));
      const passageRuntime = editRuntime({
        operation: 'replace_passage',
        query: 'teh',
        markdown: 'the',
      });
      const onNeedsDecisionChange = vi.fn();
      render(
        <LiveTools
          initial={passageRuntime}
          applyWithoutAsking
          onNeedsDecisionChange={onNeedsDecisionChange}
        />,
        { wrapper: MemoryRouter },
      );
      await waitFor(() => {
        expect(onNeedsDecisionChange).toHaveBeenLastCalledWith(['tool-1']);
      });
      expect(runWorkspaceToolSpy).not.toHaveBeenCalled();
    });
  });
  describe('editing a request before approving', () => {
    function claimEachCall() {
      client.execute.mockImplementation(
        (endpoint: { body: { operation: string; requestId: string } }) =>
          Promise.resolve({
            ...runtime,
            tools: (runtime.tools ?? []).map((tool) => ({
              ...tool,
              status: endpoint.body.operation === 'tool_result' ? 'completed' : 'claimed',
              claimId: endpoint.body.requestId,
            })),
          }),
      );
    }

    it('runs the owner’s edit, previewed again, and tells the pet what changed', async () => {
      claimEachCall();
      runWorkspaceToolSpy.mockResolvedValueOnce({
        text: 'created',
        readOnly: false,
        touchedParents: [],
      });
      show();
      await userEvent.click(await screen.findByRole('button', { name: 'Edit before approving' }));
      const title = await screen.findByLabelText(/^Title/);
      expect(title).toHaveValue('Plan');
      fireEvent.change(title, { target: { value: 'Launch plan' } });
      fireEvent.click(screen.getByRole('button', { name: 'Use these values' }));
      expect(await screen.findByText(/You edited this request/)).toBeInTheDocument();
      await approveRequest();
      await waitFor(() => {
        expect(runWorkspaceToolSpy).toHaveBeenCalledTimes(1);
      });
      expect(JSON.parse(runWorkspaceToolSpy.mock.calls[0]?.[2] as string)).toMatchObject({
        operation: 'create_note',
        title: 'Launch plan',
      });
      await waitFor(() => {
        expect(client.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              operation: 'tool_result',
              toolResult:
                'The owner edited this request before approving; it ran with: Title "Launch plan".\ncreated',
            }) as unknown,
          }),
          expect.anything(),
        );
      });
    });

    it('keeps an edit that breaks a rule from replacing the request', async () => {
      claimEachCall();
      show();
      await userEvent.click(await screen.findByRole('button', { name: 'Edit before approving' }));
      fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Use these values' }));
      expect(await screen.findByText('This field is required')).toBeInTheDocument();
      expect(screen.queryByText(/You edited this request/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Approve request' })).toBeDisabled();
    });
  });
});
