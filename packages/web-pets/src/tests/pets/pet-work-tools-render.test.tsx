import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { petConnectionSchema, type NixClient, type PetConnection } from '@nix/api-client';
import type * as ToolCard from '../../pets/work-tools/tool-card';
import { HELD_AFTER_LOCKED_READ } from '../../pets/approval/write-gate';
import { PetWorkTools } from '../../pets/work-tools/pet-work-tools';

const renders = vi.hoisted(() => ({ byTool: new Map<string, number>() }));
vi.mock('../../pets/work-tools/tool-card', async () => {
  const actual = await vi.importActual<typeof ToolCard>('../../pets/work-tools/tool-card');
  return {
    PetWorkToolCard: (props: Parameters<typeof actual.PetWorkToolCard>[0]) => {
      renders.byTool.set(props.tool.id, (renders.byTool.get(props.tool.id) ?? 0) + 1);
      return actual.PetWorkToolCard(props);
    },
  };
});

// A preview that never resolves keeps the write pending without any network.
const client = {
  execute: vi.fn(() => new Promise(() => undefined)),
  query: vi.fn(() => new Promise(() => undefined)),
  invalidate: vi.fn(),
} as unknown as NixClient;

const args = (operation: string, extra: Record<string, string> = {}) =>
  JSON.stringify({
    operation,
    title: '',
    markdown: '',
    itemId: '',
    parentId: '',
    query: '',
    propertiesJson: '',
    ...extra,
  });

// A fresh object every call, the way each watch tick hands the list a new runtime.
function freshRuntime(readStatus = 'completed', lockedRead = false): PetConnection {
  return petConnectionSchema.parse({
    provider: 'chatgpt',
    status: 'connected',
    reason: '',
    canConnect: false,
    lockedRead,
    tools: [
      { id: 'read-1', arguments: args('list_items'), status: readStatus, result: '', claimId: '' },
      {
        id: 'write-1',
        arguments: args('create_note', { title: 'Plan' }),
        status: 'pending',
        result: '',
        claimId: '',
      },
    ],
  });
}

const onChange = vi.fn();
function Tick({
  tick,
  runtime,
  applyWithoutAsking = false,
}: {
  readonly tick: number;
  readonly runtime: PetConnection;
  readonly applyWithoutAsking?: boolean;
}) {
  return (
    <MemoryRouter>
      <p>message {tick}</p>
      <PetWorkTools
        client={client}
        runtime={runtime}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={onChange}
        applyWithoutAsking={applyWithoutAsking}
      />
    </MemoryRouter>
  );
}

describe('tool cards on streamed ticks', () => {
  beforeEach(() => {
    renders.byTool.clear();
  });

  it('renders each tool card at most twice over 20 ticks that change only the message', () => {
    const view = render(<Tick tick={0} runtime={freshRuntime()} />);
    for (let tick = 1; tick <= 20; tick++)
      view.rerender(<Tick tick={tick} runtime={freshRuntime()} />);
    expect(renders.byTool.get('read-1')).toBeLessThanOrEqual(2);
    expect(renders.byTool.get('write-1')).toBeLessThanOrEqual(2);
  });

  it('still re-renders when only one tool status changes (security invariant 10)', () => {
    const view = render(<Tick tick={0} runtime={freshRuntime('claimed')} />);
    expect(screen.getByText('Running…')).toBeInTheDocument();
    view.rerender(<Tick tick={0} runtime={freshRuntime('completed')} />);
    expect(screen.getByText('Done')).toBeInTheDocument();
    view.rerender(<Tick tick={0} runtime={freshRuntime('failed')} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('still re-renders when only lockedRead changes', () => {
    const view = render(
      <Tick tick={0} runtime={freshRuntime('completed', false)} applyWithoutAsking />,
    );
    expect(screen.queryByText(HELD_AFTER_LOCKED_READ)).not.toBeInTheDocument();
    view.rerender(<Tick tick={0} runtime={freshRuntime('completed', true)} applyWithoutAsking />);
    expect(screen.getByText(HELD_AFTER_LOCKED_READ)).toBeInTheDocument();
  });

  it('still re-renders when only applyWithoutAsking changes', () => {
    const view = render(<Tick tick={0} runtime={freshRuntime('completed', true)} />);
    expect(screen.queryByText(HELD_AFTER_LOCKED_READ)).not.toBeInTheDocument();
    view.rerender(<Tick tick={0} runtime={freshRuntime('completed', true)} applyWithoutAsking />);
    expect(screen.getByText(HELD_AFTER_LOCKED_READ)).toBeInTheDocument();
  });
});
