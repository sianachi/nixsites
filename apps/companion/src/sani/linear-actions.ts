import { z } from 'zod';
import type { ConnectorAction } from './connector.ts';
import { providerJson } from './provider-json.ts';

const endpoint = 'https://api.linear.app/graphql';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const issueId = z
  .union([uuid, z.string().regex(/^[A-Z][A-Z0-9_-]{0,30}-[1-9][0-9]{0,11}$/i)])
  .transform((value) => value.toUpperCase());
const title = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^\P{Cc}+$/u);
const description = z
  .string()
  .max(8192)
  .refine((value) => !value.includes('\0'));
const dateTime = z.iso.datetime({ offset: true });
const team = z.object({ id: uuid });
const state = z.object({ id: uuid, name: z.string().min(1).max(120), team });
const issue = z.object({
  id: uuid,
  identifier: issueId,
  title,
  team,
  state: state.omit({ team: true }),
  priority: z.number().int().min(0).max(4),
  dueDate: z.iso.date().nullable(),
  updatedAt: dateTime,
  url: z.url().max(2048),
});
const fields = 'id identifier title team { id } state { id name } priority dueDate updatedAt url';

const read = z.strictObject({ issueId });
const search = z.strictObject({ query: z.string().trim().min(1).max(200) });
const listStatuses = z.strictObject({});
const create = z.strictObject({ title, description: description.optional() });
const update = z.strictObject({
  issueId,
  expectedUpdatedAt: dateTime,
  changes: z
    .strictObject({
      title: title.optional(),
      description: description.nullable().optional(),
      stateId: uuid.optional(),
      dueDate: z.iso.date().nullable().optional(),
      priority: z.number().int().min(0).max(4).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'Select at least one field to update.'),
});

type Input = Parameters<ConnectorAction['execute']>[0];

async function graphql(
  input: Input,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const response = await providerJson(input, endpoint, {
    method: 'POST',
    body: { query, variables },
  });
  const envelope = z
    .object({ data: z.unknown(), errors: z.array(z.unknown()).optional() })
    .parse(response);
  if (envelope.errors?.length) throw new Error('Linear refused the connector action.');
  return envelope.data;
}

function verifyTeam(actual: string, selected: string): void {
  if (actual !== selected) throw new Error('The Linear resource is outside the authorized team.');
}

function scopedIssue(value: z.infer<typeof issue>, selected: string, requested?: string) {
  verifyTeam(value.team.id, selected);
  if (
    requested !== undefined &&
    value.id.toUpperCase() !== requested &&
    value.identifier !== requested
  ) {
    throw new Error('Linear returned an unexpected issue.');
  }
  const url = new URL(value.url);
  const linkId = /^\/(?:[^/]+\/)?issue\/([^/]+)(?:\/[^/]+)?\/?$/.exec(url.pathname)?.[1];
  if (
    url.origin !== 'https://linear.app' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    linkId?.toUpperCase() !== value.identifier
  ) {
    throw new Error('Linear returned an unexpected issue link.');
  }
  return {
    id: value.id,
    identifier: value.identifier,
    title: value.title,
    teamId: value.team.id,
    statusId: value.state.id,
    status: value.state.name,
    priority: value.priority,
    dueDate: value.dueDate,
    updatedAt: value.updatedAt,
    url: url.href,
  };
}

async function getIssue(input: Input, requested: string, selected: string) {
  const data = await graphql(input, `query Issue($id: String!) { issue(id: $id) { ${fields} } }`, {
    id: requested,
  });
  const response = z.object({ issue }).parse(data);
  return scopedIssue(response.issue, selected, requested);
}

const issueMutation = z.object({ success: z.literal(true), issue });

export const linearActions: readonly ConnectorAction[] = [
  {
    id: 'linear.read_issue',
    kind: 'read',
    resourceKind: 'team',
    description: 'Read the title, status, and revision of one issue in the approved Linear team.',
    args: read,
    execute(input: Input): Promise<unknown> {
      const { issueId: id } = read.parse(input.args);
      return getIssue(input, id, uuid.parse(input.resourceId));
    },
  },
  {
    id: 'linear.find_issues',
    kind: 'read',
    resourceKind: 'team',
    description: 'Find up to 20 matching issue titles in the approved Linear team.',
    args: search,
    async execute(input: Input): Promise<unknown> {
      const { query } = search.parse(input.args);
      const selected = uuid.parse(input.resourceId);
      const data = await graphql(
        input,
        `query Issues($teamId: String!, $query: String!) {
          team(id: $teamId) {
            id
            issues(first: 20, filter: { title: { containsIgnoreCase: $query } }) {
              nodes { ${fields} }
              pageInfo { hasNextPage }
            }
          }
        }`,
        { teamId: selected, query },
      );
      const result = z
        .object({
          team: team.extend({
            issues: z.object({
              nodes: z.array(issue).max(20),
              pageInfo: z.object({ hasNextPage: z.boolean() }),
            }),
          }),
        })
        .parse(data);
      verifyTeam(result.team.id, selected);
      return {
        issues: result.team.issues.nodes.map((entry) => scopedIssue(entry, selected)),
        truncated: result.team.issues.pageInfo.hasNextPage,
      };
    },
  },
  {
    id: 'linear.list_statuses',
    kind: 'read',
    resourceKind: 'team',
    description: 'List workflow statuses for the approved Linear team.',
    args: listStatuses,
    async execute(input: Input): Promise<unknown> {
      listStatuses.parse(input.args);
      const selected = uuid.parse(input.resourceId);
      const data = await graphql(
        input,
        `
          query Statuses($teamId: String!) {
            team(id: $teamId) {
              id
              states(first: 50) {
                nodes {
                  id
                  name
                  team {
                    id
                  }
                }
                pageInfo {
                  hasNextPage
                }
              }
            }
          }
        `,
        { teamId: selected },
      );
      const result = z
        .object({
          team: team.extend({
            states: z.object({
              nodes: z.array(state).max(50),
              pageInfo: z.object({ hasNextPage: z.boolean() }),
            }),
          }),
        })
        .parse(data);
      verifyTeam(result.team.id, selected);
      const statuses = result.team.states.nodes.map((entry) => {
        verifyTeam(entry.team.id, selected);
        return { id: entry.id, name: entry.name };
      });
      return { statuses, truncated: result.team.states.pageInfo.hasNextPage };
    },
  },
  {
    id: 'linear.create_issue',
    kind: 'write',
    resourceKind: 'team',
    description: 'Create the reviewed issue in the approved Linear team.',
    args: create,
    async execute(input: Input): Promise<unknown> {
      const draft = create.parse(input.args);
      const selected = uuid.parse(input.resourceId);
      const data = await graphql(
        input,
        `mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { ${fields} } }
        }`,
        { input: { ...draft, teamId: selected } },
      );
      return scopedIssue(
        z.object({ issueCreate: issueMutation }).parse(data).issueCreate.issue,
        selected,
      );
    },
  },
  {
    id: 'linear.update_issue',
    kind: 'write',
    resourceKind: 'team',
    description: 'Apply the reviewed fields to an issue at its last observed revision.',
    args: update,
    async execute(input: Input): Promise<unknown> {
      const { issueId: id, expectedUpdatedAt, changes } = update.parse(input.args);
      const selected = uuid.parse(input.resourceId);
      if (changes.stateId !== undefined) {
        const data = await graphql(
          input,
          'query Status($id: String!) { workflowState(id: $id) { id name team { id } } }',
          { id: changes.stateId },
        );
        const status = z.object({ workflowState: state }).parse(data).workflowState;
        verifyTeam(status.team.id, selected);
        if (status.id !== changes.stateId) throw new Error('Linear returned an unexpected status.');
      }
      const current = await getIssue(input, id, selected);
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new Error('The Linear issue changed after review.');
      }
      // shortcut: Linear offers no conditional revision argument for issueUpdate. Use the team-scoped app grant and check the revision immediately before dispatch.
      const data = await graphql(
        input,
        `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue { ${fields} } }
        }`,
        { id: current.id, input: changes },
      );
      return scopedIssue(
        z.object({ issueUpdate: issueMutation }).parse(data).issueUpdate.issue,
        selected,
        current.id.toUpperCase(),
      );
    },
  },
];
