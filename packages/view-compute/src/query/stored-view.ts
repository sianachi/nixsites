import type { Rule } from './rules';

const KINDS = [
  'list',
  'chat',
  'habit_tracker',
  'board',
  'calendar',
  'gallery',
  'timeline',
  'sheet',
  'form',
  'query',
  'interactive_form',
  'drive',
  'checklist',
  'outline',
  'custom',
  'matrix',
  'chart',
];

export interface StoredQueryView {
  readonly id: string;
  readonly filters: readonly Rule[];
  readonly sortBy: string | null;
  readonly sortDescending: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function readLeaf(rule: Record<string, unknown>): Rule | null {
  const [property, operator, value] = [text(rule.property), text(rule.operator), text(rule.value)];
  return property !== null &&
    property.length > 0 &&
    operator !== null &&
    operator.length > 0 &&
    value !== null
    ? { property, operator, value }
    : null;
}

/** `ViewDefinitionsJson.ReadFilters`: fail-soft per rule, one level of "any of". */
function readFilters(node: unknown): Rule[] {
  if (!Array.isArray(node)) return [];
  const rules: Rule[] = [];
  for (const entry of node as unknown[]) {
    if (!isObject(entry)) continue;
    const alternatives = entry.any;
    if (Array.isArray(alternatives)) {
      const inner: Rule[] = [];
      for (const alternative of alternatives as unknown[]) {
        if (isObject(alternative) && (alternative.any === undefined || alternative.any === null)) {
          const read = readLeaf(alternative);
          if (read !== null) inner.push(read);
        }
      }
      if (inner.length > 0) rules.push({ property: '', operator: '', value: '', any: inner });
      continue;
    }
    const plain = readLeaf(entry);
    if (plain !== null) rules.push(plain);
  }
  return rules;
}

/** The view `viewId` of a stored views document, as `RunItemQuery` finds it. */
export function readQueryView(
  views: Record<string, unknown> | null,
  viewId: string,
): StoredQueryView | 'missing' | 'not-query' {
  const stored = views?.views;
  if (!Array.isArray(stored)) return 'missing';
  const seen = new Set<string>();
  for (const entry of stored as unknown[]) {
    if (!isObject(entry)) continue;
    const id = text(entry.id);
    const kind = text(entry.kind);
    if (id === null || id.length === 0 || kind === null || !KINDS.includes(kind)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (id !== viewId) continue;
    if (kind !== 'query') return 'not-query';

    let sortBy = text(entry.sortBy);
    let sortDescending = entry.sortDescending === true;
    const sorts = Array.isArray(entry.sorts) ? (entry.sorts as unknown[]) : [];
    const first = sorts.find((sort) => {
      if (!isObject(sort)) return false;
      const property = text(sort.property);
      return property !== null && property.length > 0;
    }) as Record<string, unknown> | undefined;
    if (first !== undefined) {
      sortBy = text(first.property);
      sortDescending = first.descending === true;
    }
    return { id, filters: readFilters(entry.filters), sortBy, sortDescending };
  }
  return 'missing';
}
