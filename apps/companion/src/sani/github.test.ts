import { describe, expect, it, vi } from 'vitest';
import { githubActions } from './github.ts';

const repository = 'owner/workspace';
const sha = 'a'.repeat(40);
const api = 'https://api.github.com/repos/owner/workspace';
const actor = { login: 'nix-user', email: 'ignored@example.invalid' };
const pull = {
  number: 19,
  title: 'Add a provider action',
  body: 'Review connector scopes.',
  state: 'open',
  draft: true,
  merged: false,
  updated_at: '2026-11-16T12:00:00Z',
  base: { repo: { full_name: repository } },
  head: { sha },
  user: actor,
};

function fixture(actionId: string, args: unknown, replies: unknown[], resourceId = repository) {
  const action = githubActions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error('Expected GitHub action is missing.');
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of replies) fetch.mockResolvedValueOnce(Response.json(value));
  return {
    execute: () =>
      action.execute({
        executionId: '50000000-0000-4000-8000-000000000001',
        resourceId,
        accessToken: 'test-scoped-github-access-token',
        args,
        fetch,
        signal: new AbortController().signal,
      }),
    fetch,
  };
}

function requestAt(fetch: ReturnType<typeof fixture>['fetch'], index: number) {
  const call = fetch.mock.calls[index];
  if (!call) throw new Error('Expected GitHub request.');
  return new Request(...call);
}

describe('GitHub connector actions', () => {
  it('reads an approved pull request without returning sender or repository details', async () => {
    const { execute, fetch } = fixture('github.read_pull_request', { pullNumber: 19 }, [pull]);
    await expect(execute()).resolves.toEqual({
      number: 19,
      title: 'Add a provider action',
      summary: 'Review connector scopes.',
      state: 'open',
      draft: true,
      merged: false,
      updatedAt: '2026-11-16T12:00:00Z',
      headSha: sha,
      author: 'nix-user',
      url: 'https://github.com/owner/workspace/pull/19',
    });
    const request = requestAt(fetch, 0);
    expect(request.url).toBe(`${api}/pulls/19`);
    expect(request.redirect).toBe('error');
    expect(request.headers.get('authorization')).toBe('Bearer test-scoped-github-access-token');
    expect(request.headers.get('x-github-api-version')).toBe('2022-11-28');
  });

  it('does not let a caller escape the approved repository path', async () => {
    const { execute, fetch } = fixture(
      'github.read_pull_request',
      { pullNumber: 19 },
      [],
      'owner/..',
    );
    await expect(execute()).rejects.toThrow('authorized GitHub repository');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks the pull request head and reports both check runs and commit statuses', async () => {
    const check = {
      id: 7,
      name: 'unit',
      status: 'completed',
      conclusion: 'success',
      completed_at: null,
    };
    const status = { context: 'deploy', state: 'pending' };
    const { execute, fetch } = fixture('github.list_pull_checks', { pullNumber: 19 }, [
      pull,
      { total_count: 25, check_runs: [check] },
      { sha, state: 'pending', total_count: 1, statuses: [status] },
    ]);
    await expect(execute()).resolves.toEqual({
      pullNumber: 19,
      headSha: sha,
      checks: [check],
      status: 'pending',
      statuses: [status],
      truncated: true,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${api}/pulls/19`,
      `${api}/commits/${sha}/check-runs?per_page=20`,
      `${api}/commits/${sha}/status?per_page=20`,
    ]);
  });

  it('projects reviews, line comments, and discussion onto the same approved pull request', async () => {
    const { execute } = fixture('github.list_pull_feedback', { pullNumber: 19 }, [
      pull,
      [{ id: 1, body: 'Looks good', state: 'APPROVED', user: actor }],
      [{ id: 2, body: 'What about expiry?', path: 'actions.ts', line: 20, user: null }],
      [{ id: 3, body: 'Added a test', user: actor }],
    ]);
    const url = 'https://github.com/owner/workspace/pull/19';
    await expect(execute()).resolves.toEqual({
      pullNumber: 19,
      reviews: [
        {
          id: 1,
          body: 'Looks good',
          state: 'APPROVED',
          author: 'nix-user',
          url: `${url}#pullrequestreview-1`,
        },
      ],
      inline: [
        {
          id: 2,
          body: 'What about expiry?',
          path: 'actions.ts',
          line: 20,
          author: null,
          url: `${url}#discussion_r2`,
        },
      ],
      comments: [{ id: 3, body: 'Added a test', author: 'nix-user', url: `${url}#issuecomment-3` }],
      mayHaveMore: false,
    });
  });

  it('posts only the approved comment body after confirming the reviewed pull head', async () => {
    const { execute, fetch } = fixture(
      'github.post_pull_comment',
      {
        pullNumber: 19,
        expectedHeadSha: sha,
        body: 'Please review the sample.',
      },
      [pull, { id: 22, issue_url: `${api}/issues/19`, user: actor }],
    );
    await expect(execute()).resolves.toEqual({
      id: 22,
      pullNumber: 19,
      url: 'https://github.com/owner/workspace/pull/19#issuecomment-22',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const request = requestAt(fetch, 1);
    expect(request.url).toBe(`${api}/issues/19/comments`);
    expect(request.method).toBe('POST');
    expect(await request.json()).toEqual({ body: 'Please review the sample.' });
  });

  it('does not post on a pull request changed after review', async () => {
    const { execute, fetch } = fixture(
      'github.post_pull_comment',
      {
        pullNumber: 19,
        expectedHeadSha: 'b'.repeat(40),
        body: 'This was reviewed against an older head.',
      },
      [pull],
    );
    await expect(execute()).rejects.toThrow('changed after review');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not post outside the authorized repository', async () => {
    const { execute, fetch } = fixture(
      'github.post_pull_comment',
      {
        pullNumber: 19,
        expectedHeadSha: sha,
        body: 'Please review the sample.',
      },
      [{ ...pull, base: { repo: { full_name: 'another/private' } } }],
    );
    await expect(execute()).rejects.toThrow('unexpected pull request');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
