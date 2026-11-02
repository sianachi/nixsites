/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/restrict-template-expressions, @typescript-eslint/prefer-optional-chain, @typescript-eslint/no-unnecessary-condition -- ported refusal text interpolates Core's numeric limits; request-shape checks are narrowed by hand */
import type { MirrorItem } from '@nix/sync-core/mirror';

import type { ViewAnswer, ViewCompute, ViewRequest, ViewSource } from '../types';
import { readQueryView } from './stored-view';
import {
  type Order,
  type Rule,
  FILTERABLE,
  GROUPABLE,
  MAXIMUM_PROPERTY_LENGTH,
  PRESETS,
  SORTABLE,
  isDayField,
  isReserved,
  leaves,
  needsToday,
  parseToday,
  refuseRules,
  resolveCaller,
  resolveOrder,
  todayRefusal,
  usesMe,
} from './rules';
import { type Row, type Spec, candidates, groupComparator, groupKey, match, sortRows } from './run';
import { Unanswerable, jsonbCanonical, textOf } from './text';
import { aggregate } from './aggregate';

/**
 * What a query needs beyond the shared {@link ViewSource}. Core answers `me`, `$created` and
 * `$modified` from the caller, and a smart list reads every workspace the caller may read; the
 * mirror knows all three, so the host supplies them. Without one the request is not answered
 * (null), never guessed.
 */
export interface QuerySource extends ViewSource {
  /** The acting principal's id, as an `assignee` property stores it. */
  readonly principalId?: string;
  /** The caller's preferred IANA zone; null when they have none (UTC). Undefined is unknown. */
  readonly timeZone?: string | null;
  /** Every workspace the caller may read. */
  readonly workspaceIds?: () => Promise<readonly string[]>;
}

const DEFAULT_LIMIT = 100;
const MAXIMUM_RESULTS = 500;
const MAXIMUM_GROUP_ORDER = 100;

type Json = Record<string, unknown>;

const refuse = (status: number, code: string, detail: string): ViewAnswer => ({
  status,
  code,
  detail,
});
const invalidRequest = (detail: string): ViewAnswer => refuse(400, 'query.invalid_request', detail);
const ok = (body: unknown): ViewAnswer => ({ status: 200, body });

export const computeQuery: ViewCompute = async (source, request, match) => {
  try {
    const id = (match[1] ?? '').toLowerCase();
    if (request.method === 'GET') return await runItemQuery(source, request, id);
    return await runWorkspaceQuery(source, request, id, match[2] !== undefined);
  } catch (error) {
    if (error instanceof Unanswerable) return null;
    throw error;
  }
};

function zoneFor(source: QuerySource, rules: readonly Rule[]): string | null {
  if (!leaves(rules).some((rule) => isDayField(rule.property))) return null;
  if (source.timeZone === undefined) throw new Unanswerable('the caller zone is not known');
  return source.timeZone;
}

function callerFor(source: QuerySource, rules: readonly Rule[]): readonly Rule[] {
  if (!usesMe(rules)) return rules;
  if (source.principalId === undefined) throw new Unanswerable('the caller is not known');
  return resolveCaller(rules, source.principalId);
}

function title(item: MirrorItem | undefined): string | null {
  return item === undefined
    ? null
    : textOf(Object.hasOwn(item.properties, 'title') ? item.properties.title : undefined);
}

function rowOut(row: Row, byId: Map<string, MirrorItem>, group?: string | null): Json {
  const { item } = row;
  const out: Json = {
    id: item.id,
    workspaceId: item.workspaceId,
    containerId: item.parentId,
    containerTitle: item.parentId === null ? null : title(byId.get(item.parentId)),
    title: title(item),
    type: item.type,
    properties: jsonbCanonical(item.properties),
  };
  if (group !== undefined) out.group = group;
  return out;
}

async function runItemQuery(
  source: QuerySource,
  request: ViewRequest,
  itemId: string,
): Promise<ViewAnswer> {
  const params = request.url.searchParams;
  const viewId = params.get('view');
  const todayText = params.get('today');
  if (!viewId) return refuse(404, 'query.view_not_found', 'Name the view to run: ?view=<view id>.');
  if (!todayText)
    return refuse(400, 'query.invalid_today', "Send the caller's day: ?today=yyyy-MM-dd.");
  const today = parseToday(todayText);
  if (today === null) return refuse(400, 'query.invalid_today', todayRefusal(todayText));

  const item = await source.item(itemId);
  if (item === undefined) return refuse(404, 'items.not_found', `No item ${itemId} is visible.`);
  // A lock withholds views with the body, and the mirror cannot tell a granted lock from a closed one.
  if (item.locked) throw new Unanswerable('locked');

  const found = readQueryView(item.views, viewId);
  if (found === 'missing')
    return refuse(404, 'query.view_not_found', `This item has no view '${viewId}'.`);
  if (found === 'not-query')
    return refuse(
      404,
      'query.view_not_found',
      `'${viewId}' is not a query view, so it has nothing to run.`,
    );

  const reason = refuseRules(found.filters);
  if (reason !== null)
    return refuse(
      422,
      'query.invalid_rules',
      `A stored filter no longer validates (${reason}), so the query was not run. Edit the view's filters and save them again.`,
    );

  const rules = callerFor(source, found.filters);
  const fallback: Order | null =
    found.sortBy !== null && found.sortBy.length > 0
      ? { key: found.sortBy, isDay: false, descending: found.sortDescending }
      : null;
  const spec: Spec = {
    rules,
    order: resolveOrder(rules, null, fallback),
    today,
    excludedItemId: itemId,
    zone: zoneFor(source, rules),
  };

  if (source.workspaceIds === undefined)
    throw new Unanswerable('the readable workspaces are not known');
  const all = (
    await Promise.all((await source.workspaceIds()).map((id) => source.workspaceItems(id)))
  ).flat();
  const { rows, byId } = candidates(all, source.now());
  const sorted = sortRows(match(rows, byId, spec), spec);
  return ok({
    itemId,
    viewId: found.id,
    today: todayText,
    results: sorted.slice(0, MAXIMUM_RESULTS).map((row) => rowOut(row, byId)),
    limit: MAXIMUM_RESULTS,
    truncated: sorted.length > MAXIMUM_RESULTS,
  });
}

// The request bodies Core's endpoints bind. A shape the binder would refuse with its own 400 is
// not ours to word: unanswerable.
const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function optional<T>(v: unknown, test: (x: unknown) => x is T): T | null {
  if (v === undefined || v === null) return null;
  if (!test(v)) throw new Unanswerable('unexpected request shape');
  return v;
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

interface RuleBody {
  property: string | null;
  operator: string | null;
  value: string | null;
  any: RuleBody[] | null;
}

function ruleBody(v: unknown): RuleBody | null {
  if (v === null) return null;
  if (!isObject(v)) throw new Unanswerable('unexpected request shape');
  const any = optional(v.any, Array.isArray);
  return {
    property: optional(v.property, isString),
    operator: optional(v.operator, isString),
    value: optional(v.value, isString),
    any: any === null ? null : any.map((inner) => ruleBody(inner)!),
  };
}

const SHAPE =
  'every filter needs a property, an operator and a value, empty when the operator takes none';

/** `FilterRuleContracts.RefuseShape` then `ToDomain`. */
function filtersFrom(raw: unknown): { rules: Rule[] } | { refusal: string } {
  const list = optional(raw, Array.isArray);
  if (list === null) return { rules: [] };
  const bodies = list.map(ruleBody);
  const complete = (
    r: RuleBody | null,
  ): r is RuleBody & { property: string; operator: string; value: string } =>
    r !== null && r.property !== null && r.operator !== null && r.value !== null;
  for (const rule of bodies) {
    if (rule === null) return { refusal: SHAPE };
    if (rule.any === null) {
      if (!complete(rule)) return { refusal: SHAPE };
      continue;
    }
    if (rule.any.length === 0) return { refusal: 'an "any of" group needs at least one filter' };
    for (const inner of rule.any) {
      if (inner === null || inner.any !== null)
        return { refusal: '"any of" groups do not nest; a group holds plain filters' };
      if (!complete(inner)) return { refusal: SHAPE };
    }
  }
  const toRule = (r: RuleBody): Rule =>
    r.any !== null
      ? {
          property: r.property ?? '',
          operator: r.operator ?? '',
          value: r.value ?? '',
          any: r.any.map(toRule),
        }
      : { property: r.property!, operator: r.operator!, value: r.value! };
  return { rules: bodies.map((r) => toRule(r!)) };
}

interface Prepared {
  workspaceId: string;
  spec: Spec;
  today: string | null;
}

const refuseKey = (key: string, structural: readonly string[], verb: string): string | null => {
  if (key.length === 0) return `name a property to ${verb}`;
  if (key.length > MAXIMUM_PROPERTY_LENGTH)
    return `a property key may be at most ${MAXIMUM_PROPERTY_LENGTH} characters`;
  return isReserved(key) && !structural.includes(key)
    ? `a query can ${verb} a property key or ${structural.join(', ')}, not '${key}'`
    : null;
};

async function prepare(
  source: QuerySource,
  workspaceId: string,
  body: Json,
  withSort: boolean,
  afterShape: () => string | null,
): Promise<Prepared | ViewAnswer> {
  const scope = optional(body.scope, isObject);
  const sort = withSort ? optional(body.sort, isObject) : null;
  const groupBy = optional(body.groupBy, isObject);
  const preset = optional(body.preset, isString);
  const todayText = optional(body.today, isString);

  const parsed = filtersFrom(body.filters);
  if ('refusal' in parsed) return invalidRequest(parsed.refusal);
  const sortProperty = sort === null ? null : optional(sort.property, isString);
  if (sort !== null && sortProperty === null) return invalidRequest('a sort needs a property');
  const groupProperty = groupBy === null ? null : optional(groupBy.property, isString);
  if (groupBy !== null && groupProperty === null)
    return invalidRequest('a grouping needs a property');
  const groupOrder = groupBy === null ? null : optional(groupBy.order, Array.isArray);
  if (groupOrder?.some((key) => key === null))
    return invalidRequest('a group order lists group keys, none of them null');
  if (groupOrder?.some((key) => !isString(key))) throw new Unanswerable('unexpected request shape');

  // Core checks the request's shape at the endpoint, then the aggregate, then the rules.
  const aggregateRefusal = afterShape();
  if (aggregateRefusal !== null) return invalidRequest(aggregateRefusal);

  let presetRules: readonly Rule[] = [];
  if (preset !== null) {
    const known = Object.hasOwn(PRESETS, preset) ? PRESETS[preset] : undefined;
    if (known === undefined)
      return invalidRequest(
        `'${preset}' is not a preset; use ${Object.keys(PRESETS).sort().join(', ')}`,
      );
    presetRules = known;
  }
  const rules0 = [...presetRules, ...parsed.rules];
  const reason = refuseRules(rules0);
  if (reason !== null) return invalidRequest(reason);

  let today = 0;
  if (todayText !== null) {
    const parsedToday = parseToday(todayText);
    if (parsedToday === null) return refuse(400, 'query.invalid_today', todayRefusal(todayText));
    today = parsedToday;
  } else if (leaves(rules0).some(needsToday)) {
    return refuse(
      400,
      'query.invalid_today',
      'These rules read days relative to today; send today as yyyy-MM-dd.',
    );
  }

  let explicit: Order | null = null;
  if (sortProperty !== null) {
    const bad = refuseKey(sortProperty, SORTABLE, 'sort by');
    if (bad !== null) return invalidRequest(bad);
    explicit = {
      key: sortProperty,
      isDay: sortProperty === 'due_date',
      descending: optional(sort?.descending, isBool) ?? false,
    };
  }

  let grouping: Spec['grouping'];
  if (groupProperty !== null) {
    const bad = refuseKey(groupProperty, GROUPABLE, 'group by');
    if (bad !== null) return invalidRequest(bad);
    const order = (groupOrder ?? []) as string[];
    if (order.length > MAXIMUM_GROUP_ORDER)
      return invalidRequest(`a group order may name at most ${MAXIMUM_GROUP_ORDER} groups`);
    if (order.some((key) => key.length > MAXIMUM_PROPERTY_LENGTH))
      return invalidRequest(
        `a group key in an order may be at most ${MAXIMUM_PROPERTY_LENGTH} characters`,
      );
    grouping = { key: groupProperty, order };
  }

  // The mirror holds only workspaces the caller may read, so an empty one cannot be told from a
  // workspace Core would refuse: that is for the server to say.
  const items = await source.workspaceItems(workspaceId);
  if (items.length === 0) throw new Unanswerable('workspace not in the synced copy');

  let scopeSpec: Spec['scope'];
  if (scope !== null) {
    const parentId = optional(scope.parentId, isString);
    const descendants = optional(scope.descendants, isBool) ?? true;
    if (parentId !== null) {
      if (
        !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          parentId,
        )
      )
        throw new Unanswerable('unexpected request shape');
      const id = parentId.toLowerCase();
      const parent = await source.item(id);
      if (parent === undefined || parent.workspaceId !== workspaceId)
        return refuse(404, 'items.not_found', `No item ${id} is visible.`);
      if (parent.locked) throw new Unanswerable('locked');
      scopeSpec = { parentId: id, descendants };
    }
  }

  const rules = callerFor(source, rules0);
  const spec: Spec = {
    rules,
    order: resolveOrder(rules, explicit, null),
    today,
    zone: zoneFor(source, rules),
    ...(scopeSpec === undefined ? {} : { scope: scopeSpec }),
    ...(grouping === undefined ? {} : { grouping }),
  };
  return { workspaceId, spec, today: todayText };
}

async function runWorkspaceQuery(
  source: QuerySource,
  request: ViewRequest,
  workspaceId: string,
  folded: boolean,
): Promise<ViewAnswer> {
  if (!isObject(request.body)) throw new Unanswerable('unexpected request shape');
  const body = request.body;

  let fn = '';
  let property: string | null = null;
  if (folded) {
    const spec = optional(body.aggregate, isObject);
    const name = spec === null ? null : optional(spec.function, isString);
    if (name === null)
      return invalidRequest('name the aggregate: {"aggregate": {"function": "count"}}');
    fn = name;
    property = optional(spec?.property, isString);
  }
  const limit = folded ? null : optional(body.limit, isInt);

  const prepared = await prepare(source, workspaceId, body, !folded, () =>
    folded ? refuseAggregate(fn, property) : null,
  );
  if ('status' in prepared) return prepared;
  const { spec, today } = prepared;

  const { rows, byId } = candidates(await source.workspaceItems(workspaceId), source.now());
  const matched = match(rows, byId, spec);
  const groupBy = spec.grouping?.key ?? null;

  if (folded) {
    const measure = property === null || property === '' ? null : property;
    return ok({
      workspaceId,
      today,
      function: fn,
      property: measure,
      groupBy,
      ...aggregate(matched, fn, measure, spec.grouping),
    });
  }

  const ceiling = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAXIMUM_RESULTS);
  const sorted = sortRows(matched, spec);
  const page = sorted.slice(0, ceiling);
  const sizes = new Map<string | null, number>();
  if (spec.grouping !== undefined)
    for (const row of sorted) {
      const key = groupKey(row, spec.grouping.key);
      sizes.set(key, (sizes.get(key) ?? 0) + 1);
    }
  const groups: Json[] = [];
  let previous: string | null | undefined;
  for (const row of page) {
    if (spec.grouping === undefined) break;
    const key = groupKey(row, spec.grouping.key);
    if (previous === undefined || key !== previous)
      groups.push({ key, label: key, count: sizes.get(key) ?? 0 });
    previous = key;
  }
  return ok({
    workspaceId,
    today,
    results: page.map((row) =>
      rowOut(row, byId, spec.grouping === undefined ? null : groupKey(row, spec.grouping.key)),
    ),
    limit: ceiling,
    truncated: sorted.length > ceiling,
    groupBy,
    groups,
  });
}

function refuseAggregate(fn: string, property: string | null): string | null {
  const all = ['count', 'sum', 'avg', 'min', 'max'];
  if (!all.includes(fn)) return `'${fn}' is not an aggregate; use ${all.join(', ')}`;
  const named = property !== null && property !== '';
  if (fn === 'count') return named ? "'count' counts rows and takes no property" : null;
  if (!named) return `'${fn}' folds a numeric property; name one`;
  if (property.length > MAXIMUM_PROPERTY_LENGTH)
    return `a property key may be at most ${MAXIMUM_PROPERTY_LENGTH} characters`;
  return isReserved(property)
    ? `'${property}' is a structural field, not a numeric property`
    : null;
}

export { FILTERABLE, groupComparator };
