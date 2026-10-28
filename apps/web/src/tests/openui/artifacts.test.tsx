import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fenced, fencedState, programIn, stateIn } from '../../openui/fence';

const workspace = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const counter = `root = Stack([shown, add])
shown = Text($count, "display")
add = Button("Add", @Set($count, $count + 1))
$count = 0`;

const client = { query: vi.fn(), execute: vi.fn() };
const bodies = { read: vi.fn(), append: vi.fn(), planEdit: vi.fn(), applyEdit: vi.fn() };

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
  useOptionalApiClient: () => client,
}));
vi.mock('@nix/companion', () => ({ createCompanionBodies: () => bodies }));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useAccessibleWorkspaces: () => ({
    workspaces: [{ id: workspace, name: 'Home', kind: 'personal', lifecycleState: 'active' }],
  }),
}));
vi.mock('../../views/chat/new-chat-note', () => ({ ChatDestination: () => null }));

const { default: ArtifactView } = await import('../../openui/artifact-view');
const { SaveArtifact } = await import('../../openui/save-artifact');

function artifactItem(properties: Record<string, unknown>) {
  return { id: artifactId, workspaceId: workspace, type: 'artifact', title: 'Counter', properties };
}

beforeEach(() => {
  client.query.mockReset();
  client.execute.mockReset();
  bodies.read.mockReset();
  bodies.append.mockReset();
  bodies.planEdit.mockReset();
  bodies.applyEdit.mockReset();
  bodies.read.mockResolvedValue({ markdown: `Intro\n\n${fenced(counter)}` });
  client.query.mockResolvedValue(artifactItem({}));
});

describe('fences', () => {
  it('finds the first program in a body and round-trips it', () => {
    expect(programIn(`# Title\n\n${fenced(counter)}\n${fenced('root = Stack([])')}`)).toBe(
      `${counter}\n`,
    );
    expect(programIn('no program here')).toBeNull();
    expect(stateIn(`${fenced(counter)}\n${fencedState('{"$count":2}')}`)).toEqual({
      text: '{"$count":2}',
      values: { $count: 2 },
    });
    expect(stateIn(fencedState('[1]'))).toBeNull();
  });
});

describe('an artifact', () => {
  function open() {
    render(
      <MemoryRouter>
        <ArtifactView itemId={artifactId} />
      </MemoryRouter>,
    );
  }

  it('opens with the values saved in its body, and replaces them there only when asked', async () => {
    bodies.read.mockResolvedValue({
      markdown: `${fenced(counter)}\n${fencedState('{"$count":3}')}`,
    });
    bodies.planEdit.mockResolvedValue({ fingerprint: 'body-1' });
    bodies.applyEdit.mockResolvedValue({});
    open();
    expect(await screen.findByText('3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('4')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(bodies.planEdit).not.toHaveBeenCalled();
    expect(screen.getByText(/"\$count":4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save values for everyone' }));
    await waitFor(() => {
      expect(bodies.applyEdit).toHaveBeenCalledTimes(1);
    });
    const edit = {
      kind: 'passage',
      find: '{"$count":3}',
      replace: expect.stringContaining('"$count":4') as unknown,
    };
    expect(bodies.planEdit).toHaveBeenCalledWith(artifactId, edit, expect.anything());
    expect(bodies.applyEdit).toHaveBeenCalledWith(artifactId, edit, 'body-1', expect.anything());
    expect(client.execute).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Save values for everyone' }),
      ).not.toBeInTheDocument();
    });
  });

  it('adds a values block on the first save', async () => {
    bodies.append.mockResolvedValue({});
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save values for everyone' }));
    await waitFor(() => {
      expect(bodies.append).toHaveBeenCalledTimes(1);
    });
    expect(bodies.append.mock.calls[0]?.[1]).toMatch(
      /^```openui-state\n\{.*"\$count":1.*\}\n```\n$/,
    );
  });

  it('edits only the program passage from Edit source, leaving the values block alone', async () => {
    bodies.read.mockResolvedValue({
      markdown: `Intro\n\n${fenced(counter)}\n${fencedState('{"$count":3}')}`,
    });
    bodies.planEdit.mockResolvedValue({ fingerprint: 'body-2' });
    bodies.applyEdit.mockResolvedValue({});
    render(
      <MemoryRouter>
        <ArtifactView itemId={artifactId} editable />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit source' }));
    const next = 'root = Stack([t])\nt = Text("Edited")';
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    fireEvent.change(screen.getByLabelText('Program'), { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: 'Save source' }));
    await waitFor(() => {
      expect(bodies.applyEdit).toHaveBeenCalledTimes(1);
    });
    const edit = { kind: 'passage', find: `${counter}\n`, replace: `${next}\n` };
    expect(bodies.planEdit).toHaveBeenCalledWith(artifactId, edit, expect.anything());
    expect(bodies.applyEdit).toHaveBeenCalledWith(artifactId, edit, 'body-2', expect.anything());
    expect(edit.find).not.toContain('openui-state');
    expect(bodies.append).not.toHaveBeenCalled();
  });

  it('keeps working for a viewer who cannot save, and says so', async () => {
    bodies.append.mockRejectedValue(new Error('forbidden'));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    expect(screen.getByText('1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save values for everyone' }));
    expect(await screen.findByText(/can't be saved here/)).toBeInTheDocument();
  });
});

describe('saving a chat block', () => {
  it('creates an artifact whose body holds the program and its current values', async () => {
    client.execute.mockResolvedValue({ id: artifactId });
    bodies.append.mockResolvedValue({});
    render(
      <MemoryRouter>
        <SaveArtifact
          program={counter}
          state={'{"$count":2}'}
          defaultWorkspaceId={workspace}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Artifact title'), { target: { value: 'Counter' } });
    fireEvent.click(screen.getByLabelText(/personal workspace/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(bodies.append).toHaveBeenCalled();
    });
    const created = client.execute.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(created.body).toMatchObject({ type: 'artifact', title: 'Counter', properties: null });
    expect(bodies.append.mock.calls[0]?.[1]).toBe(
      `${fenced(counter)}\n${fencedState('{"$count":2}')}`,
    );
    expect(await screen.findByRole('link', { name: 'Open the artifact' })).toHaveAttribute(
      'href',
      `/w/${workspace}?item=${artifactId}`,
    );
  });
});
