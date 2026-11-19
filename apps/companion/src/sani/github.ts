import { z } from 'zod';
import type { ConnectorAction } from './connector.ts';
import { providerJson } from './provider-json.ts';

const github = 'https://api.github.com';
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Nix',
  'X-GitHub-Api-Version': '2022-11-28',
};
const pullNumber = z.number().int().positive().max(2_147_483_647);
const sha = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
  .transform((value) => value.toLowerCase());
const githubId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const dateTime = z.iso.datetime({ offset: true });
const snippet = z.string().transform((value) => value.slice(0, 1200));
const person = z.object({ login: z.string().min(1).max(100) }).nullable();

const pullArgs = z.strictObject({ pullNumber });
const commentArgs = pullArgs.extend({
  expectedHeadSha: sha,
  body: z
    .string()
    .trim()
    .min(1)
    .max(8000)
    .refine((value) => !value.includes('\0')),
});

const pull = z.object({
  number: pullNumber,
  title: z.string().min(1).max(512),
  body: snippet.nullable(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  merged: z.boolean(),
  updated_at: dateTime,
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
  head: z.object({ sha }),
  user: person,
});

const review = z.object({
  id: githubId,
  body: snippet.nullable(),
  state: z.string().min(1).max(50),
  user: person,
});
const lineComment = z.object({
  id: githubId,
  body: snippet,
  path: z
    .string()
    .min(1)
    .max(4096)
    .transform((value) => value.slice(0, 512)),
  line: z.number().int().positive().nullable(),
  user: person,
});
const discussion = z.object({ id: githubId, body: snippet, user: person });
const checkRun = z.object({
  id: githubId,
  name: z.string().min(1).max(512),
  status: z.string().min(1).max(64),
  conclusion: z.string().min(1).max(64).nullable(),
  completed_at: dateTime.nullable(),
});
const maxChecks = 20;
const maxFeedback = 10;
const checks = z.object({
  total_count: z.number().int().min(0),
  check_runs: z.array(checkRun).max(maxChecks),
});
const combinedStatus = z.object({
  sha,
  state: z.enum(['failure', 'pending', 'success']),
  total_count: z.number().int().min(0),
  statuses: z
    .array(
      z.object({
        context: z.string().min(1).max(512),
        state: z.enum(['error', 'failure', 'pending', 'success']),
      }),
    )
    .max(maxChecks),
});

type Input = Parameters<ConnectorAction['execute']>[0];

function selectedRepository(resourceId: string) {
  const parts = /^([a-z0-9][a-z0-9_-]{0,68})\/([a-z0-9._-]{1,100})$/i.exec(resourceId);
  const owner = parts?.[1];
  const repo = parts?.[2];
  if (!owner || !repo || repo === '.' || repo === '..') {
    throw new Error('Select an authorized GitHub repository.');
  }
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    name: `${owner}/${repo}`.toLowerCase(),
    api: `${github}/repos/${path}`,
    publicUrl: `https://github.com/${path}`,
  };
}

async function readPull(input: Input, number: number) {
  const repository = selectedRepository(input.resourceId);
  const result = pull.parse(
    await providerJson(input, `${repository.api}/pulls/${String(number)}`, { headers }),
  );
  if (result.number !== number || result.base.repo.full_name.toLowerCase() !== repository.name) {
    throw new Error('GitHub returned an unexpected pull request.');
  }
  return { repository, result, url: `${repository.publicUrl}/pull/${String(number)}` };
}

export const githubActions: readonly ConnectorAction[] = [
  {
    id: 'github.read_pull_request',
    kind: 'read',
    resourceKind: 'repository',
    description: 'Read a linked pull request in the approved GitHub repository.',
    args: pullArgs,
    async execute(input: Input): Promise<unknown> {
      const { pullNumber: number } = pullArgs.parse(input.args);
      const { result, url } = await readPull(input, number);
      return {
        number,
        title: result.title,
        summary: result.body,
        state: result.state,
        draft: result.draft ?? false,
        merged: result.merged,
        updatedAt: result.updated_at,
        headSha: result.head.sha,
        author: result.user?.login ?? null,
        url,
      };
    },
  },
  {
    id: 'github.list_pull_checks',
    kind: 'read',
    resourceKind: 'repository',
    description: 'Read checks and commit status for the head of the approved pull request.',
    args: pullArgs,
    async execute(input: Input): Promise<unknown> {
      const { pullNumber: number } = pullArgs.parse(input.args);
      const { repository, result } = await readPull(input, number);
      const head = result.head.sha;
      const commit = `${repository.api}/commits/${head}`;
      const [checkData, statusData] = await Promise.all([
        providerJson(input, `${commit}/check-runs?per_page=${String(maxChecks)}`, { headers }),
        providerJson(input, `${commit}/status?per_page=${String(maxChecks)}`, { headers }),
      ]);
      const listing = checks.parse(checkData);
      const status = combinedStatus.parse(statusData);
      if (status.sha !== head) throw new Error('GitHub returned status for a different commit.');
      return {
        pullNumber: number,
        headSha: head,
        checks: listing.check_runs,
        status: status.state,
        statuses: status.statuses,
        truncated:
          listing.total_count > listing.check_runs.length ||
          status.total_count > status.statuses.length,
      };
    },
  },
  {
    id: 'github.list_pull_feedback',
    kind: 'read',
    resourceKind: 'repository',
    description:
      'Read a bounded sample of reviews, inline comments, and discussion on the approved pull request.',
    args: pullArgs,
    async execute(input: Input): Promise<unknown> {
      const { pullNumber: number } = pullArgs.parse(input.args);
      const { repository, url } = await readPull(input, number);
      const page = `?per_page=${String(maxFeedback)}`;
      const [reviewData, inlineData, discussionData] = await Promise.all([
        providerJson(input, `${repository.api}/pulls/${String(number)}/reviews${page}`, {
          headers,
        }),
        providerJson(input, `${repository.api}/pulls/${String(number)}/comments${page}`, {
          headers,
        }),
        providerJson(input, `${repository.api}/issues/${String(number)}/comments${page}`, {
          headers,
        }),
      ]);
      const reviews = z
        .array(review)
        .max(maxFeedback)
        .parse(reviewData)
        .map((entry) => ({
          id: entry.id,
          body: entry.body,
          state: entry.state,
          author: entry.user?.login ?? null,
          url: `${url}#pullrequestreview-${String(entry.id)}`,
        }));
      const inline = z
        .array(lineComment)
        .max(maxFeedback)
        .parse(inlineData)
        .map((entry) => ({
          id: entry.id,
          body: entry.body,
          path: entry.path,
          line: entry.line,
          author: entry.user?.login ?? null,
          url: `${url}#discussion_r${String(entry.id)}`,
        }));
      const comments = z
        .array(discussion)
        .max(maxFeedback)
        .parse(discussionData)
        .map((entry) => ({
          id: entry.id,
          body: entry.body,
          author: entry.user?.login ?? null,
          url: `${url}#issuecomment-${String(entry.id)}`,
        }));
      return {
        pullNumber: number,
        reviews,
        inline,
        comments,
        mayHaveMore: [reviews, inline, comments].some((group) => group.length === maxFeedback),
      };
    },
  },
  {
    id: 'github.post_pull_comment',
    kind: 'write',
    resourceKind: 'repository',
    description: 'Post the exact approved comment on the reviewed pull request.',
    args: commentArgs,
    async execute(input: Input): Promise<unknown> {
      const { pullNumber: number, expectedHeadSha, body } = commentArgs.parse(input.args);
      const { repository, result, url } = await readPull(input, number);
      if (result.head.sha !== expectedHeadSha)
        throw new Error('The pull request changed after review.');
      const response = await providerJson(
        input,
        `${repository.api}/issues/${String(number)}/comments`,
        {
          method: 'POST',
          headers,
          body: { body },
        },
      );
      const posted = z.object({ id: githubId, issue_url: z.url() }).parse(response);
      if (
        posted.issue_url.toLowerCase() !==
        `${repository.api}/issues/${String(number)}`.toLowerCase()
      ) {
        throw new Error('GitHub returned an unexpected comment receipt.');
      }
      return { id: posted.id, pullNumber: number, url: `${url}#issuecomment-${String(posted.id)}` };
    },
  },
];
