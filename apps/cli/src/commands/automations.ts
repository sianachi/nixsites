/**
 * `nixctl automations`: the caller's own automation rules (ADR-0051 section 6, Amendment 4).
 *
 * A rule is `trigger` + `conditions[]` + `actions[]`, validated by Core on every write. The CLI
 * builds the common cases from flags (a schedule, a date arriving, a property changing; notify,
 * set a property, create an item), and takes anything else - several actions in a chosen order,
 * a value that is an object - from a JSON file (`--file`, or `-` for stdin). The file may be the
 * output of `automations get`, so `get > rule.json`, edit, `update --file rule.json` round-trips,
 * saving behind the revision the file was read at.
 *
 * Flags are checked before any request so a typo fails naming the flag. Whether a rule makes
 * sense - a condition on a schedule rule, a key the scope does not declare - stays Core's
 * judgment, and its reason codes are printed as Core wrote them.
 *
 * Writes (create, update, enable, disable, delete, run, test) need a personal access token with
 * the `admin` scope; reading rules and runs needs `read`. A refusal is Core's 403, printed with
 * how to fix it (see `output.ts`).
 */

import { readFile } from 'node:fs/promises';
import {
  automations,
  type AutomationRuleInput,
  type AutomationRuleResponse,
  type AutomationRunResponse,
  type AutomationRunsPageResponse,
  type AutomationTestResponse,
} from '@nix/api-client';
import { parseScalar } from '@nix/markdown/front-matter';
import {
  parseTimeOfDay,
  parseTimeZone,
  parseUuid,
  readStdin,
  resolveSession,
  type SessionDeps,
} from './shared.ts';
import { humanReadable, printResult, printTable, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';

const FREQS = ['daily', 'weekly', 'monthly'] as const;
const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;
const MAX_OFFSET_MINUTES = 10_080;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RULE_MEMBERS = ['name', 'enabled', 'scopeItemId', 'trigger', 'conditions', 'actions'];
/** Members `automations get` prints that are Core's to set; a file may carry them unchanged. */
const RESPONSE_MEMBERS = [
  'id',
  'workspaceId',
  'revision',
  'consecutiveFailures',
  'disabledReason',
  'lastRunAt',
  'createdAt',
  'updatedAt',
];

type JsonObject = Record<string, unknown>;

/** The rule-shaping flags `create` and `update` share, as commander hands them over. */
export interface RuleFlags {
  readonly name?: string | undefined;
  /** An item id, or `none` to clear the scope. */
  readonly scope?: string | undefined;
  readonly disabled?: boolean | undefined;

  readonly schedule?: string | undefined;
  readonly at?: string | undefined;
  readonly every?: string | undefined;
  readonly weekdays?: string | undefined;
  readonly timeZone?: string | undefined;
  readonly start?: string | undefined;
  readonly whenDate?: string | undefined;
  readonly offset?: string | undefined;
  readonly whenChanged?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;

  readonly if?: readonly string[] | undefined;
  readonly ifEmpty?: readonly string[] | undefined;
  readonly ifSet?: readonly string[] | undefined;

  readonly notify?: string | undefined;
  readonly notifyBody?: string | undefined;
  readonly set?: readonly string[] | undefined;
  readonly setItem?: string | undefined;
  readonly create?: string | undefined;
  readonly createType?: string | undefined;
  readonly createUnder?: string | undefined;
  readonly createProp?: readonly string[] | undefined;
}

/** A partial rule: what a file or the flags ask to set. */
export type RulePatch = { -readonly [K in keyof AutomationRuleInput]?: AutomationRuleInput[K] };

/** A parsed rule file: the rule members it sets, and the revision it was read at, if any. */
export interface RuleFile {
  readonly rule: RulePatch;
  readonly revision?: number;
}

/**
 * Parses a rule file: an `AutomationRuleInput`, or the output of `automations get`.
 *
 * @throws When it is not a JSON object, or carries a member neither shape has.
 */
export function parseRuleFile(text: string, path: string): RuleFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object holding a rule.`);
  }
  const record = parsed as JsonObject;
  const unknown = Object.keys(record).filter(
    (key) => !RULE_MEMBERS.includes(key) && !RESPONSE_MEMBERS.includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${path} has '${unknown[0] ?? ''}', which is not a rule member. ` +
        `A rule has ${RULE_MEMBERS.join(', ')}.`,
    );
  }

  const rule: RulePatch = {};
  if (record.name !== undefined) rule.name = expectType(record.name, 'string', path, 'name');
  if (record.enabled !== undefined) {
    rule.enabled = expectType(record.enabled, 'boolean', path, 'enabled');
  }
  if (record.scopeItemId !== undefined) {
    rule.scopeItemId =
      record.scopeItemId === null
        ? null
        : parseUuid(
            expectType(record.scopeItemId, 'string', path, 'scopeItemId'),
            `${path} scopeItemId`,
          );
  }
  if (record.trigger !== undefined) rule.trigger = expectObject(record.trigger, path, 'trigger');
  if (record.conditions !== undefined) {
    rule.conditions =
      record.conditions === null ? [] : expectArray(record.conditions, path, 'conditions');
  }
  if (record.actions !== undefined) rule.actions = expectArray(record.actions, path, 'actions');

  const revision = record.revision;
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isInteger(revision))) {
    throw new Error(`${path} revision must be a whole number.`);
  }
  return revision === undefined ? { rule } : { rule, revision };
}

/**
 * The rule the flags (and optionally a file) describe, for `create`.
 *
 * @throws When the name, trigger or actions are missing, or a flag is malformed.
 */
export function buildCreateRule(flags: RuleFlags, file?: RuleFile): AutomationRuleInput {
  const shaped = shapeFlags(flags);
  if (file !== undefined && shaped.structural) {
    throw new Error(
      'Pass the trigger, conditions and actions either in --file or as flags, not both.',
    );
  }
  const base = file?.rule ?? {};
  const rule: RulePatch = { ...base, ...shaped.patch };
  if (flags.disabled === true) rule.enabled = false;

  if (rule.name === undefined)
    throw new Error('A new automation needs --name (or a name in --file).');
  if (rule.trigger === undefined) {
    throw new Error(
      'A new automation needs a trigger: --schedule, --when-date or --when-changed (or --file).',
    );
  }
  if (rule.actions === undefined || rule.actions.length === 0) {
    throw new Error(
      'A new automation needs at least one action: --notify, --set or --create (or --file).',
    );
  }
  return {
    name: rule.name,
    enabled: rule.enabled ?? true,
    scopeItemId: rule.scopeItemId ?? null,
    trigger: rule.trigger,
    conditions: rule.conditions ?? [],
    actions: rule.actions,
  };
}

/**
 * What an `update` asks to change, from flags and optionally a file, and the revision to save
 * behind when the file carries one.
 *
 * @throws When nothing would change, or a flag is malformed.
 */
export function patchFromFlags(
  flags: RuleFlags,
  file?: RuleFile,
): { readonly patch: RulePatch; readonly revision?: number } {
  const shaped = shapeFlags(flags);
  if (file !== undefined && shaped.structural) {
    throw new Error(
      'Pass the trigger, conditions and actions either in --file or as flags, not both.',
    );
  }
  const patch: RulePatch = { ...(file?.rule ?? {}), ...shaped.patch };
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'Nothing to change. Pass --file, --name, --scope, or trigger, condition or action flags.',
    );
  }
  return file?.revision === undefined ? { patch } : { patch, revision: file.revision };
}

/** The whole rule Core saves: the current rule with the patch applied. */
export function mergeRule(current: AutomationRuleResponse, patch: RulePatch): AutomationRuleInput {
  return {
    name: patch.name ?? current.name,
    enabled: patch.enabled ?? current.enabled,
    scopeItemId: patch.scopeItemId === undefined ? current.scopeItemId : patch.scopeItemId,
    trigger: patch.trigger ?? current.trigger,
    conditions: patch.conditions ?? current.conditions,
    actions: patch.actions ?? current.actions,
  };
}

function shapeFlags(flags: RuleFlags): { patch: RulePatch; structural: boolean } {
  const patch: RulePatch = {};
  if (flags.name !== undefined) {
    const name = flags.name.trim();
    if (name === '' || name.length > 200) throw new Error('--name must be 1 to 200 characters.');
    patch.name = name;
  }
  if (flags.scope !== undefined) {
    patch.scopeItemId = flags.scope === 'none' ? null : parseUuid(flags.scope, '--scope');
  }
  const trigger = triggerFromFlags(flags);
  if (trigger !== undefined) patch.trigger = trigger;
  const conditions = conditionsFromFlags(flags);
  if (conditions !== undefined) patch.conditions = conditions;
  const actions = actionsFromFlags(flags, trigger?.type as string | undefined);
  if (actions !== undefined) patch.actions = actions;
  return {
    patch,
    structural: trigger !== undefined || conditions !== undefined || actions !== undefined,
  };
}

function triggerFromFlags(flags: RuleFlags): JsonObject | undefined {
  const chosen = [
    flags.schedule === undefined ? null : '--schedule',
    flags.whenDate === undefined ? null : '--when-date',
    flags.whenChanged === undefined ? null : '--when-changed',
  ].filter((flag) => flag !== null);
  if (chosen.length > 1) {
    throw new Error(`A rule has one trigger - got ${chosen.join(' and ')}.`);
  }
  const only = (allowed: string, present: Record<string, unknown>) => {
    for (const [flag, value] of Object.entries(present)) {
      if (value !== undefined) throw new Error(`${flag} only applies to ${allowed}.`);
    }
  };

  if (flags.schedule !== undefined) {
    only('--when-date', { '--offset': flags.offset });
    only('--when-changed', { '--from': flags.from, '--to': flags.to });
    if (!(FREQS as readonly string[]).includes(flags.schedule)) {
      throw new Error(`--schedule must be one of ${FREQS.join(', ')} - got '${flags.schedule}'.`);
    }
    if (flags.at === undefined) throw new Error('--at HH:mm is required with --schedule.');
    const trigger: JsonObject = {
      type: 'schedule',
      freq: flags.schedule,
      interval: flags.every === undefined ? 1 : parseWhole(flags.every, '--every', 1, 366),
      time: parseTimeOfDay(flags.at, '--at'),
    };
    if (flags.weekdays !== undefined) {
      if (flags.schedule !== 'weekly')
        throw new Error('--weekdays only applies to --schedule weekly.');
      trigger.weekdays = parseWeekdays(flags.weekdays);
    }
    if (flags.timeZone !== undefined)
      trigger.timeZone = parseTimeZone(flags.timeZone, '--time-zone');
    if (flags.start !== undefined) {
      if (!DAY.test(flags.start))
        throw new Error(`--start must be yyyy-MM-dd - got '${flags.start}'.`);
      trigger.startDate = flags.start;
    }
    return trigger;
  }

  const scheduleOnly = {
    '--every': flags.every,
    '--weekdays': flags.weekdays,
    '--time-zone': flags.timeZone,
    '--start': flags.start,
  };

  if (flags.whenDate !== undefined) {
    only('--schedule', scheduleOnly);
    only('--when-changed', { '--from': flags.from, '--to': flags.to });
    const trigger: JsonObject = {
      type: 'date_arrives',
      key: parseKey(flags.whenDate, '--when-date'),
    };
    if (flags.offset !== undefined) {
      trigger.offsetMinutes = parseWhole(
        flags.offset,
        '--offset',
        -MAX_OFFSET_MINUTES,
        MAX_OFFSET_MINUTES,
      );
    }
    if (flags.at !== undefined) trigger.time = parseTimeOfDay(flags.at, '--at');
    return trigger;
  }

  if (flags.whenChanged !== undefined) {
    only('--schedule or --when-date', { '--at': flags.at, '--offset': flags.offset });
    only('--schedule', scheduleOnly);
    const trigger: JsonObject = {
      type: 'property_changed',
      key: parseKey(flags.whenChanged, '--when-changed'),
    };
    if (flags.from !== undefined) trigger.from = { value: parseScalar(flags.from) };
    if (flags.to !== undefined) trigger.to = { value: parseScalar(flags.to) };
    return trigger;
  }

  only('a trigger flag (--schedule, --when-date or --when-changed)', {
    '--at': flags.at,
    '--offset': flags.offset,
    '--from': flags.from,
    '--to': flags.to,
    ...scheduleOnly,
  });
  return undefined;
}

function conditionsFromFlags(flags: RuleFlags): JsonObject[] | undefined {
  const conditions: JsonObject[] = [];
  for (const expression of flags.if ?? []) {
    const unequal = expression.indexOf('!=');
    const equal = expression.indexOf('=');
    if (unequal > 0) {
      conditions.push({
        key: parseKey(expression.slice(0, unequal), '--if'),
        op: 'not_equals',
        value: parseScalar(expression.slice(unequal + 2)),
      });
    } else if (equal > 0) {
      conditions.push({
        key: parseKey(expression.slice(0, equal), '--if'),
        op: 'equals',
        value: parseScalar(expression.slice(equal + 1)),
      });
    } else {
      throw new Error(`--if must be key=value or key!=value - got '${expression}'.`);
    }
  }
  for (const key of flags.ifEmpty ?? [])
    conditions.push({ key: parseKey(key, '--if-empty'), op: 'is_empty' });
  for (const key of flags.ifSet ?? [])
    conditions.push({ key: parseKey(key, '--if-set'), op: 'is_not_empty' });
  return conditions.length === 0 ? undefined : conditions;
}

function actionsFromFlags(
  flags: RuleFlags,
  triggerType: string | undefined,
): JsonObject[] | undefined {
  const actions: JsonObject[] = [];

  if (flags.notify !== undefined) {
    const notify: JsonObject = { type: 'notify', title: flags.notify };
    if (flags.notifyBody !== undefined) notify.body = flags.notifyBody;
    actions.push(notify);
  } else if (flags.notifyBody !== undefined) {
    throw new Error('--notify-body only applies with --notify.');
  }

  if ((flags.set ?? []).length > 0) {
    const target =
      flags.setItem === undefined
        ? 'triggering_item'
        : { itemId: parseUuid(flags.setItem, '--set-item') };
    for (const pair of flags.set ?? []) {
      const equal = pair.indexOf('=');
      if (equal <= 0) throw new Error(`--set must be key=value - got '${pair}'.`);
      actions.push({
        type: 'set_property',
        target,
        key: parseKey(pair.slice(0, equal), '--set'),
        value: parseScalar(pair.slice(equal + 1)),
      });
    }
  } else if (flags.setItem !== undefined) {
    throw new Error('--set-item only applies with --set.');
  }

  if (flags.create !== undefined) {
    const parent =
      flags.createUnder === undefined
        ? triggerType === 'schedule'
          ? 'scope'
          : 'triggering_item'
        : flags.createUnder === 'triggering_item' || flags.createUnder === 'scope'
          ? flags.createUnder
          : { itemId: parseUuid(flags.createUnder, '--create-under') };
    const create: JsonObject = {
      type: 'create_item',
      parent,
      itemType: flags.createType ?? 'note',
      title: flags.create,
    };
    const properties: JsonObject = {};
    for (const pair of flags.createProp ?? []) {
      const equal = pair.indexOf('=');
      if (equal <= 0) throw new Error(`--create-prop must be key=value - got '${pair}'.`);
      properties[parseKey(pair.slice(0, equal), '--create-prop')] = parseScalar(
        pair.slice(equal + 1),
      );
    }
    if (Object.keys(properties).length > 0) create.properties = properties;
    actions.push(create);
  } else {
    for (const [flag, value] of Object.entries({
      '--create-type': flags.createType,
      '--create-under': flags.createUnder,
      '--create-prop': flags.createProp,
    })) {
      if (value !== undefined) throw new Error(`${flag} only applies with --create.`);
    }
  }

  return actions.length === 0 ? undefined : actions;
}

function parseKey(value: string, flag: string): string {
  const key = value.trim();
  if (key === '' || key.length > 128)
    throw new Error(`${flag} needs a property key of 1 to 128 characters.`);
  if (key.startsWith('$')) {
    throw new Error(`${flag} cannot name '${key}': keys starting with $ are system properties.`);
  }
  return key;
}

function parseWhole(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max || value.trim() === '') {
    throw new Error(
      `${flag} must be a whole number from ${String(min)} to ${String(max)} - got '${value}'.`,
    );
  }
  return parsed;
}

function parseWeekdays(value: string): string[] {
  const days = value.split(',').map((token) => token.trim().toLowerCase());
  for (const day of days) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) {
      throw new Error(`--weekdays must be from ${WEEKDAYS.join(', ')} - got '${day}'.`);
    }
  }
  return days;
}

function expectType<T extends 'string' | 'boolean'>(
  value: unknown,
  type: T,
  path: string,
  member: string,
): T extends 'string' ? string : boolean {
  if (typeof value !== type) throw new Error(`${path} ${member} must be a ${type}.`);
  return value as T extends 'string' ? string : boolean;
}

function expectObject(value: unknown, path: string, member: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} ${member} must be an object.`);
  }
  return value as JsonObject;
}

function expectArray(value: unknown, path: string, member: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} ${member} must be a list.`);
  return value;
}

async function readRuleFile(path: string | undefined): Promise<RuleFile | undefined> {
  if (path === undefined) return undefined;
  const text = path === '-' ? await readStdin() : await readFile(path, 'utf8');
  return parseRuleFile(text, path === '-' ? 'stdin' : path);
}

// Session-level operations, shared with the MCP server.

export async function executeListAutomations(
  session: Session,
  workspaceId: string,
): Promise<readonly AutomationRuleResponse[]> {
  return (await session.client.query(automations.list(workspaceId), { forceRefresh: true })).items;
}

export async function executeGetAutomation(
  session: Session,
  ruleId: string,
): Promise<AutomationRuleResponse> {
  return session.client.query(automations.get(ruleId), { forceRefresh: true });
}

export async function executeCreateAutomation(
  session: Session,
  workspaceId: string,
  rule: AutomationRuleInput,
): Promise<AutomationRuleResponse> {
  return session.client.execute(automations.create(workspaceId, rule));
}

/** Applies a patch to the current rule and saves it behind `expectedRevision`, else the current one. */
export async function executeUpdateAutomation(
  session: Session,
  ruleId: string,
  patch: RulePatch,
  expectedRevision?: number,
): Promise<AutomationRuleResponse> {
  const current = await executeGetAutomation(session, ruleId);
  return session.client.execute(
    automations.update(ruleId, expectedRevision ?? current.revision, mergeRule(current, patch)),
  );
}

/** Enables or disables a rule; a rule already in that state is returned unchanged, with no write. */
export async function executeSetAutomationEnabled(
  session: Session,
  ruleId: string,
  enabled: boolean,
): Promise<AutomationRuleResponse> {
  const current = await executeGetAutomation(session, ruleId);
  if (current.enabled === enabled) return current;
  return session.client.execute(
    automations.update(ruleId, current.revision, mergeRule(current, { enabled })),
  );
}

export async function executeDeleteAutomation(
  session: Session,
  ruleId: string,
): Promise<{ readonly id: string; readonly deleted: true }> {
  await session.client.execute(automations.remove(ruleId));
  return { id: ruleId, deleted: true };
}

export async function executeListAutomationRuns(
  session: Session,
  ruleId: string,
  cursor?: string,
): Promise<AutomationRunsPageResponse> {
  return session.client.query(automations.runs(ruleId, cursor), { forceRefresh: true });
}

export async function executeRunAutomation(
  session: Session,
  ruleId: string,
  itemId?: string,
): Promise<AutomationRunResponse> {
  return session.client.execute(automations.run(ruleId, itemId ?? null));
}

export async function executeTestAutomation(
  session: Session,
  ruleId: string,
  itemId?: string,
): Promise<AutomationTestResponse> {
  return session.client.execute(automations.dryRun(ruleId, itemId ?? null));
}

// CLI commands.

export async function listAutomations(
  profileName: string | undefined,
  workspaceId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(workspaceId, '--workspace');
  const session = await resolveSession(profileName, deps);
  const rules = await executeListAutomations(session, workspaceId);
  if (humanReadable(output)) {
    printTable(
      ['ID', 'NAME', 'ENABLED', 'TRIGGER', 'FAILURES', 'LAST RUN'],
      rules.map((rule) => [
        rule.id,
        rule.name,
        rule.enabled
          ? 'yes'
          : `no${rule.disabledReason === null ? '' : ` (${rule.disabledReason})`}`,
        typeof rule.trigger.type === 'string' ? rule.trigger.type : '',
        String(rule.consecutiveFailures),
        rule.lastRunAt ?? '',
      ]),
    );
    return;
  }
  printResult({ items: rules }, output);
}

export async function getAutomation(
  profileName: string | undefined,
  ruleId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(ruleId, 'The automation id');
  const session = await resolveSession(profileName, deps);
  printResult(await executeGetAutomation(session, ruleId), output);
}

export interface CreateAutomationOptions extends RuleFlags {
  readonly workspace: string;
  readonly file?: string | undefined;
}

export async function createAutomation(
  profileName: string | undefined,
  options: CreateAutomationOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(options.workspace, '--workspace');
  const rule = buildCreateRule(options, await readRuleFile(options.file));
  const session = await resolveSession(profileName, deps);
  printResult(await executeCreateAutomation(session, options.workspace, rule), output);
}

export interface UpdateAutomationOptions extends RuleFlags {
  readonly file?: string | undefined;
  readonly revision?: string | undefined;
}

export async function updateAutomation(
  profileName: string | undefined,
  ruleId: string,
  options: UpdateAutomationOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(ruleId, 'The automation id');
  const { patch, revision: fileRevision } = patchFromFlags(
    options,
    await readRuleFile(options.file),
  );
  const revision =
    options.revision === undefined
      ? fileRevision
      : parseWhole(options.revision, '--revision', 0, Number.MAX_SAFE_INTEGER);
  const session = await resolveSession(profileName, deps);
  printResult(await executeUpdateAutomation(session, ruleId, patch, revision), output);
}

export async function setAutomationEnabled(
  profileName: string | undefined,
  ruleId: string,
  enabled: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(ruleId, 'The automation id');
  const session = await resolveSession(profileName, deps);
  printResult(await executeSetAutomationEnabled(session, ruleId, enabled), output);
}

export async function deleteAutomation(
  profileName: string | undefined,
  ruleId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(ruleId, 'The automation id');
  if (!confirmed) throw new Error('This destructive operation requires --yes.');
  const session = await resolveSession(profileName, deps);
  printResult(await executeDeleteAutomation(session, ruleId), output);
}

export async function listAutomationRuns(
  profileName: string | undefined,
  ruleId: string,
  options: { readonly cursor?: string | undefined },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(ruleId, 'The automation id');
  const session = await resolveSession(profileName, deps);
  const page = await executeListAutomationRuns(session, ruleId, options.cursor);
  if (humanReadable(output)) {
    printTable(
      ['CREATED', 'STATUS', 'REASON', 'ORIGIN', 'DEPTH', 'ITEM'],
      page.items.map((run) => [
        run.createdAt,
        run.status,
        run.reason ?? '',
        run.origin,
        String(run.depth),
        run.itemId ?? '',
      ]),
    );
    if (page.nextCursor !== null) process.stdout.write(`next page --cursor ${page.nextCursor}\n`);
    return;
  }
  printResult(page, output);
}

export interface RunAutomationOptions {
  readonly item?: string | undefined;
}

export async function runAutomation(
  profileName: string | undefined,
  ruleId: string,
  options: RunAutomationOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(ruleId, 'The automation id');
  const item = options.item === undefined ? undefined : parseUuid(options.item, '--item');
  const session = await resolveSession(profileName, deps);
  printResult(await executeRunAutomation(session, ruleId, item), output);
}

export async function testAutomation(
  profileName: string | undefined,
  ruleId: string,
  options: RunAutomationOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(ruleId, 'The automation id');
  const item = options.item === undefined ? undefined : parseUuid(options.item, '--item');
  const session = await resolveSession(profileName, deps);
  printResult(await executeTestAutomation(session, ruleId, item), output);
}
