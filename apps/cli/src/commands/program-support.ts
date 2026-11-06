import type { Command } from 'commander';

export interface LsOptions {
  readonly workspace: string;
  readonly parent?: string;
  readonly deleted?: boolean;
}

export interface CreateItemOptions {
  readonly workspace: string;
  readonly title: string;
  readonly type: string;
  readonly parent?: string;
  readonly prop: string[];
  readonly idempotencyKey?: string;
  readonly strict?: boolean;
}

export interface MvOptions {
  readonly workspace: string;
  readonly destinationWorkspace?: string;
  readonly parent?: string;
  readonly after?: string;
}

export interface WorkspaceOption {
  readonly workspace: string;
}

export interface PageCliOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ConfirmCliOptions {
  readonly yes?: boolean;
}

export function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

/** Parses a `<seq>` positional argument; a history `seq` is always a non-negative integer. */
export function parseSeqArg(value: string): number {
  const seq = Number.parseInt(value, 10);
  if (!Number.isInteger(seq) || seq < 0 || String(seq) !== value) {
    throw new Error(`'${value}' is not a valid sequence number.`);
  }
  return seq;
}

/** The rule-shaping flags `automations create` and `automations update` share. */
export function ruleFlags(command: Command): Command {
  return command
    .option('--file <path>', "a JSON rule, or the output of 'automations get' ('-' for stdin)")
    .option('--name <name>', 'the rule name')
    .option('--scope <itemId|none>', 'only items under this container (none clears it)')
    .option('--schedule <freq>', 'trigger on a schedule: daily | weekly | monthly')
    .option('--at <HH:mm>', 'schedule time, or the time a date-only value arrives')
    .option('--every <n>', 'schedule interval (1-366, default 1)')
    .option('--weekdays <days>', 'weekly schedule days: comma-separated mo,tu,we,th,fr,sa,su')
    .option('--time-zone <iana>', 'schedule zone (default: yours)')
    .option('--start <yyyy-mm-dd>', 'first day of the schedule')
    .option('--when-date <key>', 'trigger when a date property arrives, e.g. due_date')
    .option('--offset <minutes>', 'fire this many minutes after (negative: before) the date')
    .option('--when-changed <key>', 'trigger when a property changes')
    .option('--from <value>', 'only when it changes from this value')
    .option('--to <value>', 'only when it changes to this value')
    .option(
      '--if <key=value|key!=value>',
      'condition on the triggering item (repeatable)',
      collectOptional,
    )
    .option('--if-empty <key>', 'condition: the property is empty (repeatable)', collectOptional)
    .option('--if-set <key>', 'condition: the property is set (repeatable)', collectOptional)
    .option('--notify <title>', 'action: notify you; {date} and {item.title} are filled in')
    .option('--notify-body <body>', 'the notification body')
    .option(
      '--set <key=value>',
      'action: set a property on the triggering item (repeatable)',
      collectOptional,
    )
    .option('--set-item <itemId>', 'set the --set properties on this item instead')
    .option('--create <title>', 'action: create an item with this title')
    .option('--create-type <type>', 'the created item type (default note)')
    .option('--create-under <triggering_item|scope|itemId>', 'where the item is created')
    .option(
      '--create-prop <key=value>',
      'a property of the created item (repeatable)',
      collectOptional,
    );
}

/** Like {@link collectOption}, but absent (undefined) until the flag is first given. */
export function collectOptional(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseTemplateInputPairs(
  entries: readonly string[],
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      throw new Error(`Template input '${entry}' must use key=value syntax.`);
    }
    const key = entry.slice(0, separator);
    if (Object.hasOwn(values, key)) {
      throw new Error(`Template input '${key}' was supplied more than once.`);
    }
    values[key] = entry.slice(separator + 1);
  }
  if (Object.keys(values).length > 100) {
    throw new Error('A template accepts at most 100 inputs.');
  }
  return values;
}

export interface ImportCliOptions {
  readonly workspace: string;
  readonly parent?: string;
  readonly dryRun?: boolean;
}

export interface SeedCliOptions {
  readonly workspace: string;
  readonly count: number;
  readonly parent?: string;
  readonly titlePrefix?: string;
  readonly type?: string;
  readonly prop?: readonly string[];
}

export interface RunCliOptions {
  readonly scenario: string;
  readonly iterations?: number;
  readonly create?: boolean;
  readonly clients?: number;
  readonly edits?: number;
  readonly intervalMs?: number;
  readonly item?: string;
  readonly workspace?: string;
  readonly pageSize?: number;
  readonly query?: string;
  readonly limit?: number;
  readonly view?: string;
  readonly today?: string;
}

export interface LoginOptions {
  readonly apiUrl: string;
  readonly token?: string;
  readonly browserUrl?: string;
  readonly browser?: boolean;
  readonly collabUrl?: string;
  readonly mediaUrl?: string;
  /** commander sets this false when `--no-default` is passed. */
  readonly default?: boolean;
}

/** Commander accumulator for a repeatable option. */
export const collect = (value: string, previous: string[]): string[] => [...previous, value];
