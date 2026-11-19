import { describe, expect, it, vi } from 'vitest';
import { linearActions } from './linear-actions.ts';

const team = '10000000-0000-4000-8000-000000000001';
const otherTeam = '10000000-0000-4000-8000-000000000002';
const issue = '20000000-0000-4000-8000-000000000001';
const state = '30000000-0000-4000-8000-000000000001';
const revision = '2026-11-16T12:30:00.000Z';

function row(teamId = team) {
  return {
    id: issue,
    identifier: 'NIX-37',
    title: 'Track the acceptance check',
    team: { id: teamId },
    state: { id: state, name: 'In progress' },
    priority: 3,
    dueDate: null,
    updatedAt: revision,
    url: 'https://linear.app/test/issue/NIX-37/track-the-acceptance-check',
    description: 'Unselected field',
  };
}

function fixture(actionId: string, args: unknown, ...replies: unknown[]) {
  const action = linearActions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error('Expected Linear action is missing.');
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of replies) fetch.mockResolvedValueOnce(Response.json(value));
  return {
    execute: () =>
      action.execute({
        executionId: '40000000-0000-4000-8000-000000000001',
        resourceId: team,
        accessToken: 'test-scoped-linear-access-token',
        args,
        fetch,
        signal: new AbortController().signal,
      }),
    fetch,
  };
}

function requestAt(fetch: ReturnType<typeof fixture>['fetch'], index: number) {
  const [url, options] = fetch.mock.calls[index] ?? [];
  if (url === undefined || typeof options?.body !== 'string')
    throw new Error('Expected GraphQL request.');
  return new Request(url, options);
}

describe('Linear connector actions', () => {
  it('reads a single issue through the scoped team and projects the sync fields', async () => {
    const { execute, fetch } = fixture(
      'linear.read_issue',
      { issueId: 'nix-37' },
      { data: { issue: row() } },
    );
    await expect(execute()).resolves.toEqual({
      id: issue,
      identifier: 'NIX-37',
      title: 'Track the acceptance check',
      teamId: team,
      statusId: state,
      status: 'In progress',
      priority: 3,
      dueDate: null,
      updatedAt: revision,
      url: 'https://linear.app/test/issue/NIX-37/track-the-acceptance-check',
    });
    const request = requestAt(fetch, 0);
    expect(request.url).toBe('https://api.linear.app/graphql');
    expect(request.redirect).toBe('error');
    expect(request.headers.get('authorization')).toBe('Bearer test-scoped-linear-access-token');
    expect(await request.json()).toMatchObject({ variables: { id: 'NIX-37' } });
  });

  it('does not expose an issue outside the authorized team', async () => {
    const { execute } = fixture(
      'linear.read_issue',
      { issueId: 'NIX-37' },
      { data: { issue: row(otherTeam) } },
    );
    await expect(execute()).rejects.toThrow('outside the authorized team');
  });

  it('searches only the scoped team and identifies capped results', async () => {
    const query = 'Roadmap for "pets"';
    const { execute, fetch } = fixture(
      'linear.find_issues',
      { query },
      {
        data: { team: { id: team, issues: { nodes: [row()], pageInfo: { hasNextPage: true } } } },
      },
    );
    await expect(execute()).resolves.toMatchObject({ issues: [{ id: issue }], truncated: true });
    const request = requestAt(fetch, 0);
    expect(await request.clone().text()).toContain('team(id: $teamId)');
    expect(await request.json()).toMatchObject({ variables: { teamId: team, query } });
  });

  it('creates with the approved team ID and rejects a caller-supplied destination', async () => {
    const { execute, fetch } = fixture(
      'linear.create_issue',
      { title: 'Track it', description: 'Review the release' },
      {
        data: { issueCreate: { success: true, issue: { ...row(), title: 'Track it' } } },
      },
    );
    await expect(execute()).resolves.toMatchObject({ id: issue, title: 'Track it' });
    expect(await requestAt(fetch, 0).json()).toMatchObject({
      variables: { input: { teamId: team, title: 'Track it', description: 'Review the release' } },
    });
    const wrong = fixture('linear.create_issue', { title: 'Track it', teamId: otherTeam });
    await expect(wrong.execute()).rejects.toThrow();
    expect(wrong.fetch).not.toHaveBeenCalled();
  });

  it('refuses a stale reviewed mutation before sending it', async () => {
    const { execute, fetch } = fixture(
      'linear.update_issue',
      {
        issueId: issue,
        expectedUpdatedAt: '2026-11-15T12:30:00.000Z',
        changes: { priority: 2 },
      },
      { data: { issue: row() } },
    );
    await expect(execute()).rejects.toThrow('changed after review');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cannot apply a status from a different team', async () => {
    const { execute, fetch } = fixture(
      'linear.update_issue',
      {
        issueId: issue,
        expectedUpdatedAt: revision,
        changes: { stateId: state },
      },
      { data: { workflowState: { id: state, name: 'Done', team: { id: otherTeam } } } },
    );
    await expect(execute()).rejects.toThrow('outside the authorized team');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('updates the reviewed fields once using the resolved issue ID', async () => {
    const changes = { stateId: state, priority: 2 };
    const { execute, fetch } = fixture(
      'linear.update_issue',
      {
        issueId: 'NIX-37',
        expectedUpdatedAt: revision,
        changes,
      },
      { data: { workflowState: { id: state, name: 'In progress', team: { id: team } } } },
      { data: { issue: row() } },
      { data: { issueUpdate: { success: true, issue: { ...row(), priority: 2 } } } },
    );
    await expect(execute()).resolves.toMatchObject({ id: issue, priority: 2 });
    expect(fetch).toHaveBeenCalledTimes(3);
    const request = requestAt(fetch, 2);
    expect(await request.clone().text()).toContain('mutation UpdateIssue');
    expect(await request.json()).toMatchObject({ variables: { id: issue, input: changes } });
  });

  it('refuses partial GraphQL data and keeps provider errors out of the result', async () => {
    const { execute } = fixture(
      'linear.read_issue',
      { issueId: 'NIX-37' },
      {
        data: { issue: row() },
        errors: [{ message: 'Untrusted provider text' }],
      },
    );
    await expect(execute()).rejects.toThrow('Linear refused the connector action.');
  });
});
