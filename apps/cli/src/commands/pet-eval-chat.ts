import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkOpenUi } from './openui-check.ts';
import { baselineOf, compareToBaseline, readBaseline, writeBaseline } from './pet-eval-baseline.ts';
import { z } from 'zod';
import {
  items,
  references,
  views,
  type Item,
  type PetConnection,
  type PetToolCall,
  type TemplateSummary,
} from '@nix/api-client';
import {
  canApplyWithoutAsking,
  describeToolCall,
  executeBuild,
  hasExternalLink,
  loadPreviewContext,
  planBuild,
  readStructure,
  READ_ONLY_OPERATIONS,
  workspaceToolSchema,
  type CompanionPorts,
} from '@nix/companion';
import {
  blueprintSchema,
  chatSuiteSchema,
  saveSpecSchema,
  WORKSPACE_OPERATIONS,
  type ChatAssertion,
  type ChatCase,
} from '@nix/structure-spec';
import { printResult, printTable, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';
import { executePetToolRun, petSessionFor } from './pets.ts';
import type { SessionDeps } from './shared.ts';
import { portsFor } from './blueprint.ts';
import { postLocalToolResult, runtime } from './pet-eval.ts';
import {
  seedEvalTemplate,
  registerEvalTemplate,
  removeEvalTemplates,
} from './pet-eval-templates.ts';

/** docs/plans/pet-tool-use-plan.md, lane E: the chat suite. A fixture is built from one
 * blueprint, every case is one owner message, tools run for real under the lane F policy
 * (plus "inside the fixture"), and the case is scored on which tools were attempted and on the
 * workspace state read back afterwards. Nothing here teaches the model anything: the point is
 * a number that moves when the tools or the prompt change. */

const POLL_INTERVAL_MS = 3_000;
const CASE_TIMEOUT_MS = 180_000;
const DECLINED_PREFIX = 'Evaluation run: declined';
const KNOWN_OPERATIONS: ReadonlySet<string> = new Set(WORKSPACE_OPERATIONS);

export interface ChatEvalOptions {
  readonly suite: 'chat';
  readonly case?: string;
  readonly model?: string;
  readonly apiUrl?: string;
  readonly workspace?: string;
  readonly pet?: string;
  /** Approve writes that the lane F policy allows and that target the fixture. Off: every write
   * is declined and recorded, which still scores whether the right tool was attempted. */
  readonly allowWrites?: boolean;
  /** Leave the fixture in place after the run. */
  readonly keep?: boolean;
  readonly runs?: number;
  /** Gate on this recorded baseline: exit 1 only on a regression against it. */
  readonly baseline?: string;
  /** Record this run's per-case pass counts as a new baseline. */
  readonly writeBaseline?: string;
}

export interface ChatToolRecord {
  readonly operation: string;
  readonly decision: 'ran' | 'declined';
  readonly reason?: string;
  readonly success: boolean;
  readonly ms: number;
}

export interface ChatCaseResult {
  readonly id: string;
  readonly run: number;
  readonly model: string | null;
  readonly outcome: 'done' | 'tool_limit' | 'timeout' | 'error';
  readonly pass: boolean;
  readonly failures: string[];
  readonly tools: ChatToolRecord[];
  /** Replies are scored in memory; unrestricted reads can contain private workspace content. */
  readonly answer: null;
  readonly answerLength: number;
  /** Nix links in the reply that resolve to a readable item of the eval workspace, and those that
   * do not. Counts only: the reply itself is never kept. */
  readonly citations: { readonly valid: number; readonly invalid: number };
  /** Allowlisted case-defined gap codes and failed operation names; no raw tool output. */
  readonly feedback: {
    readonly code: string;
    readonly source: 'answer' | 'tool';
    readonly operation?: string;
  }[];
  readonly durationMs: number;
}

/** The built fixture: the container every write must stay inside, and each blueprint node's
 * item. Tests supply their own instead of building one. */
export interface ChatFixture {
  readonly rootId: string;
  readonly nodes: ReadonlyMap<string, string>;
  readonly templateSourceId?: string;
  /** Only successful local capture receipts enter this registry. */
  readonly templates?: Map<string, TemplateSummary>;
}

export interface ChatEvalRuntime {
  readonly session: Session;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly today: () => string;
  readonly seed?: (
    session: Session,
    workspaceId: string,
    today: string,
    fixtureName?: string,
  ) => Promise<ChatFixture>;
  readonly teardown?: (
    session: Session,
    workspaceId: string,
    fixture: ChatFixture,
  ) => Promise<void>;
}

function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Replaces `{today}`, `{today+N}` and `{today-N}` with ISO dates relative to `today`. */
export function substituteDates(text: string, today: string): string {
  return text.replaceAll(/\{today([+-]\d+)?\}/g, (_match, offset: string | undefined) => {
    const base = new Date(`${today}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + (offset ? Number(offset) : 0));
    return base.toISOString().slice(0, 10);
  });
}

async function readJson(relative: string): Promise<unknown> {
  const file = new URL(
    `../../../../packages/structure-spec/evals/chat/${relative}`,
    import.meta.url,
  );
  return JSON.parse(await readFile(file, 'utf8'));
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Links the hub note to the meeting note, then waits for the backlink to be indexed: references
 * are published when a snapshot is taken, so reading them straight away is a race. The
 * backlinks case depends on it, so a link that never shows fails the build rather than the case. */
export async function seedFixtureLinks(
  ports: CompanionPorts,
  session: Session,
  fixture: ChatFixture,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const meeting = resolveNode(fixture, 'meeting-note');
  const hub = resolveNode(fixture, 'hub-note');
  await ports.bodies.append(
    hub,
    `[Planning meeting](nix://item/${meeting})`,
    AbortSignal.timeout(30_000),
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);
    const { backlinks } = await session.client.query(references.listBacklinks(meeting), {
      forceRefresh: true,
    });
    if (backlinks.some((entry) => entry.source.id === hub)) return;
  }
  throw new Error('The fixture link was not indexed as a backlink in time.');
}

/** Builds the fixture under a fresh container at the workspace root, so teardown is one trash
 * and "inside the fixture" is one ancestry walk. */
async function buildFixture(
  session: Session,
  workspaceId: string,
  today: string,
  fixtureName?: string,
): Promise<ChatFixture> {
  const file = fixtureName ? `fixture-${fixtureName}.json` : 'fixture.json';
  const raw = substituteDates(JSON.stringify(await readJson(file)), today);
  const blueprint = blueprintSchema.parse(JSON.parse(raw));
  const container = await session.client.execute(
    items.createItem(workspaceId, {
      type: 'note',
      title: `Eval chat ${new Date().toISOString().replace(/[:.]/g, '-')}`,
      parentId: null,
    }),
  );
  const ports = portsFor(session);
  const plan = planBuild(blueprint, {
    parentId: container.id,
    sandboxExists: true,
    clock: ports.clock,
    inheritedFields: [],
  });
  const built = await executeBuild(ports, workspaceId, plan, AbortSignal.timeout(180_000));
  if (!built.complete) {
    await session.client.execute(items.deleteItem(workspaceId, container.id));
    throw new Error(`The fixture did not build completely (${built.instruction}).`);
  }
  const nodes = new Map<string, string>();
  for (const entry of built.ledger)
    if (entry.itemId && !nodes.has(entry.nodeId)) nodes.set(entry.nodeId, entry.itemId);
  const fixture = { rootId: container.id, nodes };
  try {
    // Only the main fixture has the hub and meeting notes the backlinks case links.
    if (nodes.has('hub-note')) await seedFixtureLinks(ports, session, fixture, wait);
  } catch (reason) {
    await session.client.execute(items.deleteItem(workspaceId, container.id));
    throw reason;
  }
  const queryNodes: string[] = [];
  const collect = (node: typeof blueprint.root) => {
    if (node.views?.some((view) => view.kind === 'query')) queryNodes.push(node.id);
    for (const child of node.children ?? []) collect(child);
  };
  collect(blueprint.root);
  try {
    await scopeFixtureQueryViews(session, fixture, queryNodes);
  } catch (reason) {
    await session.client.execute(items.deleteItem(workspaceId, container.id));
    throw reason;
  }
  return fixture;
}

async function trashFixture(
  session: Session,
  workspaceId: string,
  fixture: ChatFixture,
): Promise<void> {
  await session.client.execute(items.deleteItem(workspaceId, fixture.rootId));
}

function resolveNode(fixture: ChatFixture, node: string): string {
  const id = fixture.nodes.get(node);
  if (!id) throw new Error(`The fixture has no node '${node}'.`);
  return id;
}

async function titleOf(session: Session, id: string): Promise<string> {
  return (await session.client.query(items.itemById(id), { forceRefresh: true })).title;
}

/** Whether `itemId` is the fixture container or sits anywhere below it. */
async function insideFixture(
  session: Session,
  fixture: ChatFixture,
  itemId: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const seen: string[] = [];
  let current: string | null = itemId;
  let inside = false;
  for (let depth = 0; current && depth < 16; depth += 1) {
    const known = cache.get(current);
    if (known !== undefined) {
      inside = known;
      break;
    }
    if (current === fixture.rootId) {
      inside = true;
      break;
    }
    seen.push(current);
    try {
      const item: Item = await session.client.query(items.itemById(current), {
        forceRefresh: true,
      });
      current = item.parentId;
    } catch {
      break;
    }
  }
  for (const id of seen) cache.set(id, inside);
  return inside;
}

/** A saved query otherwise searches the owner's workspace. Seeded evaluation queries stay
 * within their own fixture container, preserving their deliberately correct or incorrect rules. */
export async function scopeFixtureQueryViews(
  session: Session,
  fixture: ChatFixture,
  queryNodes: readonly string[],
): Promise<void> {
  const ancestry = new Map<string, boolean>();
  for (const node of new Set(queryNodes)) {
    const itemId = resolveNode(fixture, node);
    if (!(await insideFixture(session, fixture, itemId, ancestry)))
      throw new Error('The query fixture target is outside the seeded fixture.');
    const configuration = await session.client.query(views.containerViewConfigurations(itemId), {
      forceRefresh: true,
    });
    const scoped = configuration.views.map((view) => {
      if (
        view.kind !== 'query' ||
        view.filters.some(
          (rule) =>
            rule.any === null &&
            rule.property === '$inside' &&
            rule.operator === 'equals' &&
            rule.value === itemId,
        )
      )
        return view;
      const conditions = view.filters.reduce((count, rule) => count + (rule.any?.length ?? 1), 0);
      if (conditions >= 8)
        throw new Error(
          'The query fixture has no room for its isolation filter (maximum 8 conditions).',
        );
      return {
        ...view,
        filters: [
          ...view.filters,
          { property: '$inside', operator: 'equals', value: itemId, any: null },
        ],
      };
    });
    if (scoped.some((view, index) => view !== configuration.views[index]))
      await session.client.execute(
        views.setContainerViews(itemId, {
          views: scoped,
          default: configuration.default,
          hideDocument: configuration.hideDocument,
        }),
      );
  }
}

function operationOf(tool: PetToolCall): string {
  try {
    const args: unknown = JSON.parse(tool.arguments);
    return typeof args === 'object' &&
      args !== null &&
      'operation' in args &&
      typeof args.operation === 'string' &&
      KNOWN_OPERATIONS.has(args.operation)
      ? args.operation
      : 'unparseable';
  } catch {
    return 'unparseable';
  }
}

/** Why a write may not run on its own, or undefined when it may. Mirrors the web card: the
 * lane F policy, the external-link rule, the hold after a read of locked content (the worker's
 * conversation-level `lockedRead`), body-edit preview and formatting holds, the hold on completing
 * an occurrence of a repeating task, and the harness's own fixture boundary. */
export async function declineReason(
  session: Session,
  fixture: ChatFixture,
  tool: PetToolCall,
  allowWrites: boolean,
  cache: Map<string, boolean>,
  lockedRead = false,
  ports?: CompanionPorts,
  workspaceId?: string,
  onPreview?: (fingerprint: string) => void,
  approvedOperations: readonly ChatCase['approvedOperations'][number][] = [],
): Promise<string | undefined> {
  let parsed: ReturnType<typeof workspaceToolSchema.safeParse>;
  try {
    parsed = workspaceToolSchema.safeParse(JSON.parse(tool.arguments));
  } catch {
    parsed = workspaceToolSchema.safeParse(null);
  }
  if (!parsed.success) return 'unsupported request';
  const args = parsed.data;
  if (args.operation === 'read_template' && !fixture.templates?.has(args.itemId))
    return 'the template was not captured by this fixture';
  // A memory goes into the signed-in owner's own pet settings, outside every fixture; the attempt
  // is what a case scores.
  if (args.operation === 'remember') return 'evaluations never save memories';
  if (READ_ONLY_OPERATIONS.has(args.operation)) return undefined;
  if (!allowWrites) return 'writes are not allowed in this run';
  const approved = new Set<string>(approvedOperations);
  if (!canApplyWithoutAsking(args.operation) && !approved.has(args.operation))
    return `${args.operation} always asks`;
  if (lockedRead) return "earlier reads need the owner's review before changes";
  const bodyEdit = args.operation === 'replace_section' || args.operation === 'replace_passage';
  const viewEdit = args.operation === 'update_view';
  const templateSave = args.operation === 'save_as_template';
  if (templateSave) {
    if (args.itemId !== fixture.templateSourceId)
      return 'only the approved synthetic fixture note may be captured';
    let spec: ReturnType<typeof saveSpecSchema.safeParse>;
    try {
      spec = saveSpecSchema.safeParse(args.specJson.trim() ? JSON.parse(args.specJson) : {});
    } catch {
      return 'unsupported template capture settings';
    }
    if (
      !spec.success ||
      !spec.data.includeSamples ||
      spec.data.inputs?.length ||
      spec.data.rules?.length
    )
      return 'the fixture capture must include samples and have no initialization rules';
  }
  if (bodyEdit || viewEdit || templateSave || args.operation === 'complete_task') {
    // The same preview the card reads: an occurrence of a repeating task cannot be reopened, so it
    // never runs unattended. Without a preview there is no way to tell, so it does not run either.
    if (ports === undefined || workspaceId === undefined)
      return bodyEdit
        ? 'the body edit has no preview'
        : viewEdit
          ? 'the view edit has no preview'
          : templateSave
            ? 'the template capture has no preview'
            : 'the task may repeat and there is no preview';
    try {
      const context = await loadPreviewContext(
        ports,
        workspaceId,
        args,
        AbortSignal.timeout(30_000),
      );
      const model = describeToolCall(args, context);
      if (model.problems.length > 0) return 'the preview has problems';
      if (templateSave && context.sourceItemCount !== 1)
        return 'the approved template source must remain a single synthetic note';
      if (context.taskCompletion?.kind === 'occurrence')
        return "completing a repeating task's occurrence cannot be undone";
      if (bodyEdit) {
        if (model.bodyEdit === undefined) return 'the body edit has no preview';
        if (model.bodyEdit.losesFormatting) return 'the body edit removes formatting';
        if (hasExternalLink([model.bodyEdit.after])) return 'the text links to another host';
      }
      onPreview?.(context.fingerprint);
    } catch {
      return bodyEdit
        ? 'the body edit preview could not be loaded'
        : viewEdit
          ? 'the view edit preview could not be loaded'
          : templateSave
            ? 'the template capture preview could not be loaded'
            : 'the task preview could not be loaded';
    }
  }
  if (hasExternalLink([args.title, args.markdown, args.specJson, args.propertiesJson]))
    return 'the text links to another host';
  if (args.operation === 'apply_template' && !fixture.templates?.has(args.itemId))
    return 'the template was not captured by this fixture';
  const targets = [args.operation === 'apply_template' ? '' : args.itemId, args.parentId].filter(
    (id) => id.trim(),
  );
  if (targets.length === 0) return 'the target is the workspace root, outside the fixture';
  for (const id of targets)
    if (!(await insideFixture(session, fixture, id, cache)))
      return 'the target is outside the fixture';
  return undefined;
}

function declineTool(
  session: Session,
  workspaceId: string,
  petId: string,
  tool: PetToolCall,
  reason: string,
): Promise<void> {
  const result = `${DECLINED_PREFIX}: ${reason}. Do not retry it.`;
  return postLocalToolResult(session, workspaceId, petId, tool, result, false);
}

function matches(list: readonly string[], attempted: readonly string[]): string[] {
  return list.filter(
    (entry) => !entry.split('|').some((alternative) => attempted.includes(alternative)),
  );
}

function inOrder(expected: readonly string[], attempted: readonly string[]): boolean {
  let index = 0;
  for (const operation of attempted) {
    const entry = expected[index];
    if (entry?.split('|').includes(operation)) index += 1;
  }
  return index === expected.length;
}

/** JSON object order is not a configuration difference; ordered arrays still are. */
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameJson(entry, right[index]))
    );
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return (
      keys.length === Object.keys(rightRecord).length &&
      keys.every(
        (key) => Object.hasOwn(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return Object.is(left, right);
}

function resolveFixtureJson(value: unknown, fixture: ChatFixture): unknown {
  if (typeof value === 'string') {
    const match = /^\{item:([a-z][a-z0-9-]*)\}$/.exec(value);
    return match ? resolveNode(fixture, match[1] ?? '') : value;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveFixtureJson(entry, fixture));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveFixtureJson(entry, fixture)]),
    );
  return value;
}

function isWrite(operation: string): boolean {
  // A memory changes the owner's settings, so a review that must not write must not remember.
  return (
    operation === 'remember' ||
    !READ_ONLY_OPERATIONS.has(operation as Parameters<typeof READ_ONLY_OPERATIONS.has>[0])
  );
}

async function checkAssertion(
  session: Session,
  ports: CompanionPorts,
  workspaceId: string,
  fixture: ChatFixture,
  assertion: ChatAssertion,
): Promise<string | undefined> {
  switch (assertion.kind) {
    case 'child': {
      const parentId = resolveNode(fixture, assertion.parent);
      const title = new RegExp(assertion.title, 'i');
      const found: { id: string; title: string; properties: Record<string, unknown> }[] = [];
      for await (const item of session.client.paginate(
        items.listItems(workspaceId, { parentId, pageSize: 50 }),
        {
          forceRefresh: true,
        },
      )) {
        if (title.test(item.title))
          found.push({ id: item.id, title: item.title, properties: item.properties });
      }
      if (assertion.count !== undefined && found.length !== assertion.count)
        return `${assertion.parent} has ${String(found.length)} children matching /${assertion.title}/, expected ${String(assertion.count)}`;
      if (!assertion.exists)
        return found.length === 0
          ? undefined
          : `a child matching /${assertion.title}/ exists under ${assertion.parent}`;
      if (found.length === 0)
        return `no child matching /${assertion.title}/ under ${assertion.parent}`;
      const candidates = found.filter((item) =>
        Object.entries(assertion.values ?? {}).every(([key, value]) =>
          sameJson(item.properties[key], value),
        ),
      );
      if (candidates.length === 0)
        return `no child matching /${assertion.title}/ carries ${JSON.stringify(assertion.values)}`;
      for (const candidate of candidates) {
        if (assertion.fields || assertion.views) {
          const configured = await readStructure(
            ports,
            workspaceId,
            candidate.id,
            AbortSignal.timeout(30_000),
          );
          const fieldsMatch = (assertion.fields ?? []).every((expected) => {
            const field = configured.fields.find((entry) => entry.key === expected.key);
            return (
              field !== undefined &&
              Object.entries(expected.equals ?? {}).every(([key, value]) =>
                sameJson(
                  (field as unknown as Record<string, unknown>)[key],
                  resolveFixtureJson(value, fixture),
                ),
              )
            );
          });
          const viewsMatch = (assertion.views ?? []).every((expected) => {
            const named = configured.views.filter((entry) => entry.name === expected.name);
            return (
              named.length === 1 &&
              Object.entries(expected.equals).every(([key, value]) =>
                sameJson(
                  (named[0] as unknown as Record<string, unknown>)[key],
                  resolveFixtureJson(value, fixture),
                ),
              )
            );
          });
          if (!fieldsMatch || !viewsMatch) continue;
        }
        if (assertion.noteContains !== undefined) {
          const body = (await ports.bodies.read(candidate.id, AbortSignal.timeout(30_000))) as {
            markdown?: string;
          };
          if (!new RegExp(assertion.noteContains, 'i').test(body.markdown ?? '')) continue;
        }
        return undefined;
      }
      return `no child matching /${assertion.title}/ has the requested fields, views and note content`;
    }
    case 'value': {
      const item = await session.client.query(
        items.itemById(resolveNode(fixture, assertion.item)),
        {
          forceRefresh: true,
        },
      );
      const values = assertion.source === 'computed' ? item.computed : item.properties;
      const value: unknown = values?.[assertion.key];
      if (assertion.truthy !== undefined)
        return Boolean(value) === assertion.truthy
          ? undefined
          : `${assertion.item}.${assertion.key} is ${JSON.stringify(value)}, expected ${assertion.truthy ? 'truthy' : 'falsy'}`;
      if (!sameJson(value, assertion.equals))
        return `${assertion.item}.${assertion.key} is ${JSON.stringify(value)}, expected ${JSON.stringify(assertion.equals)}`;
      return undefined;
    }
    case 'note': {
      const body = (await ports.bodies.read(
        resolveNode(fixture, assertion.item),
        AbortSignal.timeout(30_000),
      )) as {
        markdown?: string;
      };
      const hit = new RegExp(assertion.contains, 'i').test(body.markdown ?? '');
      if (assertion.absent)
        return hit ? `${assertion.item} still contains /${assertion.contains}/` : undefined;
      return hit ? undefined : `${assertion.item} does not contain /${assertion.contains}/`;
    }
    case 'field': {
      const structure = await readStructure(
        ports,
        workspaceId,
        resolveNode(fixture, assertion.item),
        AbortSignal.timeout(30_000),
      );
      const field = structure.fields.find((entry) => entry.key === assertion.key);
      if (!field) {
        const keys = structure.fields.map((entry) => entry.key);
        return `${assertion.item} declares no field '${assertion.key}' (has ${keys.join(', ') || 'none'})`;
      }
      const values = field as unknown as Record<string, unknown>;
      const different = Object.entries(assertion.equals ?? {})
        .filter(([key, value]) => !sameJson(values[key], resolveFixtureJson(value, fixture)))
        .map(([key]) => key);
      return different.length === 0
        ? undefined
        : `${assertion.item} field '${assertion.key}' differs at ${different.join(', ')}`;
    }
    case 'parent': {
      const item = await session.client.query(
        items.itemById(resolveNode(fixture, assertion.item)),
        {
          forceRefresh: true,
        },
      );
      const expected = resolveNode(fixture, assertion.parent);
      return item.parentId === expected
        ? undefined
        : `${assertion.item} is no longer under ${assertion.parent}`;
    }
    case 'view': {
      const configured = await session.client.query(
        views.containerViewConfigurations(resolveNode(fixture, assertion.item)),
        { forceRefresh: true },
      );
      const named = configured.views.filter((view) => view.name === assertion.name);
      if (!assertion.exists)
        return named.length === 0
          ? undefined
          : `${assertion.item} still has a view named '${assertion.name}'`;
      if (named.length !== 1)
        return `${assertion.item} has ${String(named.length)} views named '${assertion.name}', expected one`;
      const view = named[0] as Record<string, unknown>;
      const different = Object.entries(assertion.equals)
        .filter(([key, value]) => !sameJson(view[key], resolveFixtureJson(value, fixture)))
        .map(([key]) => key);
      return different.length === 0
        ? undefined
        : `${assertion.item} view '${assertion.name}' differs at ${different.join(', ')}`;
    }
  }
}

class RetainEvaluationFixture extends Error {
  constructor(message = 'Could not stop the evaluation turn; its fixture was left in place.') {
    super(message);
  }
}

/** A tool limit or timeout ends the harness loop before the provider has necessarily stopped.
 * Interrupt and observe settlement before resetting or removing its write targets. */
async function stopEvaluationTurn(
  session: Session,
  workspaceId: string,
  petId: string,
  sleep: ChatEvalRuntime['sleep'],
): Promise<void> {
  try {
    let connection = await runtime(session, workspaceId, petId, 'interrupt');
    for (let attempt = 0; connection.state === 'thinking' && attempt < 10; attempt += 1) {
      await sleep(POLL_INTERVAL_MS);
      connection = await runtime(session, workspaceId, petId, 'read');
    }
    if (connection.state === 'thinking') throw new RetainEvaluationFixture();
  } catch {
    throw new RetainEvaluationFixture();
  }
}

/** Runs one case: one message, tools handled as they arrive, then the assertions. */
export async function runChatCase(
  chatCase: ChatCase,
  run: number,
  options: ChatEvalOptions & { workspace: string; pet: string },
  fixture: ChatFixture,
  runner: ChatEvalRuntime,
): Promise<ChatCaseResult> {
  const { session, sleep } = runner;
  const ports = portsFor(session);
  const model = options.model ?? null;
  const tools: ChatToolRecord[] = [];
  const handled = new Set<string>();
  const ancestry = new Map<string, boolean>();
  const started = Date.now();
  let outcome: ChatCaseResult['outcome'] = 'timeout';
  let answer = '';
  let retained = false;
  const prompt = await replaceNodeTitles(chatCase.prompt, fixture, session);
  const openItem = chatCase.currentItem ? resolveNode(fixture, chatCase.currentItem) : undefined;
  await runtime(session, options.workspace, options.pet, 'reset');
  try {
    await runtime(session, options.workspace, options.pet, 'send', {
      text: prompt,
      workspaceAccess: chatCase.workspaceAccess,
      requestId: crypto.randomUUID(),
      ...(openItem === undefined ? {} : { itemId: openItem }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    while (Date.now() - started < CASE_TIMEOUT_MS) {
      const connection = await runtime(session, options.workspace, options.pet, 'read');
      const tool = connection.tools?.find(
        (entry) => entry.status === 'pending' && !handled.has(entry.id),
      );
      if (tool) {
        handled.add(tool.id);
        const operation = operationOf(tool);
        if (tools.length >= chatCase.tools.max) {
          await declineTool(
            session,
            options.workspace,
            options.pet,
            tool,
            'the tool budget is spent',
          );
          tools.push({
            operation,
            decision: 'declined',
            reason: 'tool budget',
            success: false,
            ms: 0,
          });
          outcome = 'tool_limit';
          break;
        }
        const at = Date.now();
        let fingerprint: string | undefined;
        const reason = !chatCase.workspaceAccess
          ? 'workspace access is disabled for this case'
          : chatCase.noWrites && isWrite(operation)
            ? 'this case is a read-only review'
            : await declineReason(
                session,
                fixture,
                tool,
                options.allowWrites ?? false,
                ancestry,
                connection.lockedRead,
                ports,
                options.workspace,
                (value) => {
                  fingerprint = value;
                },
                chatCase.approvedOperations,
              );
        if (reason !== undefined) {
          await declineTool(session, options.workspace, options.pet, tool, reason);
          tools.push({
            operation,
            decision: 'declined',
            reason,
            success: false,
            ms: Date.now() - at,
          });
          continue;
        }
        let after: PetConnection;
        try {
          after = (await executePetToolRun(
            session,
            options.workspace,
            options.pet,
            tool.id,
            'approve',
            canApplyWithoutAsking(operation as Parameters<typeof canApplyWithoutAsking>[0]) ||
              new Set<string>(chatCase.approvedOperations).has(operation)
              ? { arguments: tool.arguments, ...(fingerprint === undefined ? {} : { fingerprint }) }
              : undefined,
          )) as PetConnection;
        } catch (error) {
          if (operation === 'save_as_template')
            throw new RetainEvaluationFixture(
              'Template capture did not return a confirmed result; its fixture was left in place.',
            );
          throw error;
        }
        const status = after.tools?.find((entry) => entry.id === tool.id)?.status;
        if (operation === 'save_as_template' && status !== 'completed')
          throw new RetainEvaluationFixture(
            'Template capture did not return a confirmed result; its fixture was left in place.',
          );
        if (operation === 'save_as_template' && status === 'completed') {
          try {
            const receipt = after.tools?.find((entry) => entry.id === tool.id);
            const result = z
              .object({ templateId: z.uuid() })
              .parse(JSON.parse(receipt?.result ?? ''));
            if (!fixture.templates) throw new Error('Missing fixture template registry');
            await registerEvalTemplate(
              session,
              options.workspace,
              result.templateId,
              fixture.templates,
            );
          } catch {
            throw new RetainEvaluationFixture(
              'Could not verify the saved template; its fixture was left in place.',
            );
          }
        }
        tools.push({
          operation,
          decision: 'ran',
          success: status === 'completed',
          ms: Date.now() - at,
        });
        continue;
      }
      if (connection.state === 'success' || connection.state === 'error') {
        outcome = connection.state === 'error' ? 'error' : 'done';
        answer =
          connection.messages?.findLast(
            (message) => message.role === 'assistant' && !message.id.includes(':draft:'),
          )?.text ?? '';
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    retained = error instanceof RetainEvaluationFixture;
    throw error;
  } finally {
    if (outcome !== 'done' && outcome !== 'error')
      await stopEvaluationTurn(session, options.workspace, options.pet, sleep);
    // Keep the settled conversation as recovery evidence for an uncertain capture. A reset
    // failure must not replace its retention error and cause the suite to delete the source.
    if (!retained) await runtime(session, options.workspace, options.pet, 'reset');
  }

  const attempted = tools.map((tool) => tool.operation);
  const failures: string[] = [];
  if (outcome !== 'done') failures.push(`outcome ${outcome}`);
  for (const missing of matches(chatCase.tools.require, attempted))
    failures.push(`never attempted ${missing}`);
  const succeeded = tools
    .filter((tool) => tool.decision === 'ran' && tool.success)
    .map((tool) => tool.operation);
  for (const missing of matches(chatCase.tools.requireSuccessful, succeeded))
    failures.push(`never completed ${missing}`);
  for (const hit of chatCase.tools.forbid.filter((entry) =>
    entry.split('|').some((alt) => attempted.includes(alt)),
  ))
    failures.push(`attempted forbidden ${hit}`);
  if (chatCase.tools.inOrder && !inOrder(chatCase.tools.inOrder, attempted))
    failures.push(`tools not in order ${chatCase.tools.inOrder.join(' > ')}`);
  if (chatCase.answer && !new RegExp(chatCase.answer, 'i').test(answer))
    failures.push(`answer does not match /${chatCase.answer}/`);
  if (chatCase.answerNot && new RegExp(chatCase.answerNot, 'i').test(answer))
    failures.push(`answer matches /${chatCase.answerNot}/`);
  if (chatCase.noWrites && attempted.some(isWrite)) failures.push('review attempted a write');
  if (!chatCase.workspaceAccess && attempted.length > 0)
    failures.push('attempted a tool with workspace access disabled');
  const checks = chatCase.answerChecks;
  if (checks) {
    for (const expression of checks.all)
      if (!new RegExp(expression, 'i').test(answer))
        failures.push(`answer lacks required signal /${expression}/`);
    if (
      checks.any.length > 0 &&
      !checks.any.some((expression) => new RegExp(expression, 'i').test(answer))
    )
      failures.push('answer lacks every alternative signal');
    for (const expression of checks.absent)
      if (new RegExp(expression, 'i').test(answer))
        failures.push(`answer contains forbidden signal /${expression}/`);
    for (const ref of checks.references) {
      const id = resolveNode(fixture, ref);
      const title = await titleOf(session, id);
      if (!answer.toLowerCase().includes(title.toLowerCase()) && !answer.includes(id))
        failures.push(`answer does not reference fixture item '${ref}'`);
    }
    for (const ref of checks.cites)
      if (!citationPattern(options.workspace, resolveNode(fixture, ref)).test(answer))
        failures.push(`answer does not link fixture item '${ref}'`);
    if (checks.openui) failures.push(...(await checkOpenUi(answer, checks.openui)));
  }
  const citations = await scoreCitations(session, options.workspace, answer);
  if (citations.invalid > 0)
    failures.push('answer links an item that is not readable or does not exist');
  const feedback: ChatCaseResult['feedback'] = [
    ...chatCase.feedbackChecks
      .filter((check) => new RegExp(check.matches, 'i').test(answer))
      .map((check) => ({ code: check.code, source: 'answer' as const })),
    ...[
      ...new Set(
        tools
          .filter((tool) => tool.decision === 'ran' && !tool.success)
          .map((tool) => tool.operation),
      ),
    ].map((operation) => ({ code: 'tool-failed', source: 'tool' as const, operation })),
  ];
  for (const assertion of chatCase.asserts) {
    try {
      const failure = await checkAssertion(session, ports, options.workspace, fixture, assertion);
      if (failure) failures.push(failure);
    } catch (reason) {
      failures.push(
        `assertion ${assertion.kind} could not be checked: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }
  // Opt-in, for diagnosing a failing case: results stay answer-free by default, since a reply can
  // quote workspace content.
  const answersDir = process.env.NIX_EVAL_ANSWERS_DIR;
  if (answersDir)
    await writeFile(join(answersDir, `${chatCase.id}-${String(run)}.md`), answer, 'utf8');
  return {
    id: chatCase.id,
    run,
    model,
    outcome,
    pass: failures.length === 0,
    failures,
    tools,
    answer: null,
    answerLength: answer.length,
    citations,
    feedback,
    durationMs: Date.now() - started,
  };
}

/** The Nix link a reply uses for an item: `/w/{workspaceId}?item={itemId}`, as the instructions
 * ask and `pet-message-text.tsx` renders. */
function citationPattern(workspaceId: string, itemId: string): RegExp {
  return new RegExp(`/w/${workspaceId}/?\\?item=${itemId}`, 'i');
}

/** Counts the reply's Nix links that name this workspace and an item the owner can read. An
 * invented id, or a link into another workspace, is invalid. */
async function scoreCitations(
  session: Session,
  workspaceId: string,
  answer: string,
): Promise<{ valid: number; invalid: number }> {
  const links = new Set(
    [...answer.matchAll(/\/w\/([0-9a-f-]{36})\/?\?item=([0-9a-f-]{36})/gi)].map(
      (match) => `${(match[1] ?? '').toLowerCase()} ${(match[2] ?? '').toLowerCase()}`,
    ),
  );
  let valid = 0;
  for (const link of links) {
    const [workspace, id] = link.split(' ');
    try {
      const item = await session.client.query(items.itemById(id ?? ''), { forceRefresh: true });
      if (workspace === workspaceId.toLowerCase() && item.workspaceId === workspaceId) valid += 1;
    } catch {
      /* Unreadable and missing look the same to the owner. */
    }
  }
  return { valid, invalid: links.size - valid };
}

async function replaceNodeTitles(
  prompt: string,
  fixture: ChatFixture,
  session: Session,
): Promise<string> {
  const refs = [...prompt.matchAll(/\{node:([a-z][a-z0-9-]*)\}/g)].map((match) => match[1] ?? '');
  const titles = new Map<string, string>();
  for (const ref of new Set(refs))
    titles.set(ref, await titleOf(session, resolveNode(fixture, ref)));
  return prompt.replaceAll(
    /\{node:([a-z][a-z0-9-]*)\}/g,
    (_match, ref: string) => titles.get(ref) ?? ref,
  );
}

export async function readChatCases(id: string | undefined): Promise<ChatCase[]> {
  const all = chatSuiteSchema.parse(await readJson('cases.json'));
  if (!id) return all;
  // A trailing `*` selects a group by prefix: `context-*`.
  const selected = all.filter((entry) =>
    id.endsWith('*') ? entry.id.startsWith(id.slice(0, -1)) : entry.id === id,
  );
  if (selected.length === 0)
    throw new Error(
      `Unknown chat case '${id}'. Choose: ${all.map((entry) => entry.id).join(', ')}.`,
    );
  return selected;
}

function failedCase(
  id: string,
  run: number,
  model: string | null,
  error: unknown,
  started: number,
): ChatCaseResult {
  return {
    id,
    run,
    model,
    outcome: 'error',
    pass: false,
    failures: [`error: ${error instanceof Error ? error.message : String(error)}`],
    tools: [],
    answer: null,
    answerLength: 0,
    citations: { valid: 0, invalid: 0 },
    feedback: [],
    durationMs: Date.now() - started,
  };
}

async function historyIds(
  session: Session,
  options: { workspace: string; pet: string },
): Promise<Set<string>> {
  const listed = await runtime(session, options.workspace, options.pet, 'history');
  return new Set((listed.history ?? []).map((entry) => entry.id));
}

/** Each case's reset archives its conversation, and the worker keeps at most 32 archives per
 * conversation, so a long suite deletes the archives that appeared during a case, and only those.
 * A failure here is not worth the suite's results: the next case simply finds one more archive. */
async function pruneCaseHistory(
  session: Session,
  options: { workspace: string; pet: string },
  before: ReadonlySet<string> | undefined,
): Promise<void> {
  if (before === undefined) return;
  try {
    for (const id of await historyIds(session, options))
      if (!before.has(id))
        await runtime(session, options.workspace, options.pet, 'delete_history', {
          historyId: id,
        });
  } catch {
    // Best effort: see above.
  }
}

export async function runChatSuite(
  cases: readonly ChatCase[],
  options: ChatEvalOptions & { workspace: string; pet: string },
  runner: ChatEvalRuntime,
): Promise<ChatCaseResult[]> {
  const results: ChatCaseResult[] = [];
  const runs = options.runs ?? 1;
  const seed = runner.seed ?? buildFixture;
  const teardown = runner.teardown ?? trashFixture;
  for (let run = 1; run <= runs; run += 1) {
    for (const chatCase of cases) {
      // One fresh fixture per case: a case must never see another case's writes.
      const built = await seed(runner.session, options.workspace, runner.today(), chatCase.fixture);
      const ownedTemplates = new Map<string, TemplateSummary>();
      const fixture: ChatFixture = {
        ...built,
        templates: ownedTemplates,
        ...(chatCase.templateSource === undefined
          ? {}
          : { templateSourceId: resolveNode(built, chatCase.templateSource) }),
      };
      let retained = false;
      try {
        if (fixture.templateSourceId) {
          try {
            await seedEvalTemplate(
              runner.session,
              options.workspace,
              fixture.templateSourceId,
              ownedTemplates,
            );
          } catch {
            // A transport/response failure may follow a durable capture without returning its
            // identity. Keep the source and any known capture until its state can be inspected.
            throw new RetainEvaluationFixture(
              'Template setup could not be confirmed; its fixture was left in place.',
            );
          }
        }
        const started = Date.now();
        const before = await historyIds(runner.session, options).catch(() => undefined);
        try {
          results.push(await runChatCase(chatCase, run, options, fixture, runner));
        } catch (error) {
          if (error instanceof RetainEvaluationFixture) throw error;
          // A provider or Core failure fails this case, not the whole suite and the results so far.
          results.push(failedCase(chatCase.id, run, options.model ?? null, error, started));
        }
        await pruneCaseHistory(runner.session, options, before);
      } catch (error) {
        retained = error instanceof RetainEvaluationFixture;
        throw error;
      } finally {
        if (!options.keep && !retained) {
          await removeEvalTemplates(runner.session, ownedTemplates);
          await teardown(runner.session, options.workspace, fixture);
        }
      }
    }
  }
  return results;
}

export async function petEvalChat(
  profile: string | undefined,
  options: ChatEvalOptions,
  output: OutputOptions,
  deps: SessionDeps & {
    sleep?: (milliseconds: number) => Promise<void>;
    today?: () => string;
  } = {},
): Promise<void> {
  if (!options.workspace || !options.pet) throw new Error('Provide --workspace and --pet.');
  const cases = await readChatCases(options.case);
  // Read before the run, which spends real model calls, so a missing or broken baseline fails now.
  const baseline = options.baseline ? await readBaseline(options.baseline) : undefined;
  const session = await petSessionFor(options.apiUrl, profile, deps);
  // Every case resets the conversation, which archives what it held; on a pet the owner also talks
  // to, the first reset would archive (and the clean-up delete) their real conversation.
  const live = await runtime(session, options.workspace, options.pet, 'read');
  if ((live.messages ?? []).length > 0)
    throw new Error(
      'This pet has a conversation in this workspace. Run evaluations in a dedicated workspace or with a dedicated pet.',
    );
  const runner: ChatEvalRuntime = {
    session,
    sleep:
      deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    today: deps.today ?? localToday,
  };
  const results = await runChatSuite(
    cases,
    { ...options, workspace: options.workspace, pet: options.pet },
    runner,
  );
  const runs = options.runs ?? 1;
  if (options.writeBaseline)
    await writeBaseline(options.writeBaseline, baselineOf(results, runs, new Date()));
  const comparison = baseline ? compareToBaseline(results, runs, baseline) : undefined;
  if (baseline && (results[0]?.model ?? null) !== baseline.model)
    process.stderr.write(
      `The baseline was recorded with model ${baseline.model ?? 'default'}; this run used ${results[0]?.model ?? 'default'}.\n`,
    );
  if (output.json || !output.isTty)
    printResult(comparison ? { results, baseline: comparison } : results, output);
  else {
    printTable(
      ['Case', 'Run', 'Outcome', 'Pass', 'Tools', 'Declined', 'Links', 'Feedback', 'Seconds'],
      results.map((result) => [
        result.id,
        String(result.run),
        result.outcome,
        result.pass ? 'pass' : 'fail',
        String(result.tools.length),
        String(result.tools.filter((tool) => tool.decision === 'declined').length),
        `${String(result.citations.valid)}/${String(result.citations.invalid)}`,
        String(result.feedback.length),
        (result.durationMs / 1000).toFixed(1),
      ]),
    );
    const passed = results.filter((result) => result.pass).length;
    process.stdout.write(`\n${String(passed)} of ${String(results.length)} passed.\n`);
    for (const result of results.filter((entry) => entry.feedback.length > 0))
      process.stdout.write(
        `  ${result.id}: ${result.feedback.map((entry) => (entry.operation ? `${entry.code} (${entry.operation})` : entry.code)).join(', ')}\n`,
      );
    for (const result of results.filter((entry) => !entry.pass)) {
      process.stdout.write(`\n${result.id} (run ${String(result.run)})\n`);
      for (const failure of result.failures) process.stdout.write(`  - ${failure}\n`);
      process.stdout.write(
        `  tools: ${result.tools.map((tool) => `${tool.operation}${tool.decision === 'declined' ? ` (declined: ${tool.reason ?? ''})` : tool.success ? '' : ' (failed)'}`).join(', ') || 'none'}\n`,
      );
    }
  }
  if (comparison && output.isTty && !output.json)
    process.stdout.write(
      `\nBaseline: ${(comparison.rate * 100).toFixed(1)}% now, ${(comparison.baselineRate * 100).toFixed(1)}% recorded.` +
        (comparison.regressions.length > 0
          ? ` Regressed: ${comparison.regressions.join(', ')}.`
          : '') +
        (comparison.unrecorded.length > 0
          ? ` Not in the baseline: ${comparison.unrecorded.join(', ')}.`
          : '') +
        `\n`,
    );
  // Recording a baseline is the run's purpose, so its known failures are not an error.
  const failed = comparison
    ? comparison.regressed
    : !options.writeBaseline && results.some((result) => !result.pass);
  if (failed) process.exitCode = 1;
}
