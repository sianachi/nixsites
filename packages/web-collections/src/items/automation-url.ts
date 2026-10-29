import { z } from 'zod';

/**
 * What the automations page shows, read from its address, following `routing/url-state.ts`: one
 * schema per parameter, a reader that always answers, and nothing thrown at a hand-typed link.
 *
 * - `?rule=<id>` opens one rule.
 * - `?new=1` opens a new rule; `&scope=<item id>` prefills its scope, which is what the item menu's
 *   "Automate..." sends.
 * - Neither lists the rules.
 */

export const AUTOMATION_RULE_PARAM = 'rule';
export const AUTOMATION_NEW_PARAM = 'new';
export const AUTOMATION_SCOPE_PARAM = 'scope';

const idSchema = z.uuid();

export type AutomationSelection =
  | { readonly kind: 'list' }
  | { readonly kind: 'new'; readonly scopeItemId: string | null }
  | { readonly kind: 'rule'; readonly ruleId: string };

function readId(params: URLSearchParams, name: string): string | null {
  const raw = params.get(name);
  if (raw === null) return null;
  const parsed = idSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn(`Ignoring unrecognised "${name}" search parameter:`, raw);
  return null;
}

export function parseAutomationSelection(params: URLSearchParams): AutomationSelection {
  const ruleId = readId(params, AUTOMATION_RULE_PARAM);
  if (ruleId !== null) return { kind: 'rule', ruleId };
  if (params.get(AUTOMATION_NEW_PARAM) === '1') {
    return { kind: 'new', scopeItemId: readId(params, AUTOMATION_SCOPE_PARAM) };
  }
  return { kind: 'list' };
}

/** The page's address for a selection, inside one workspace. */
export function automationsHref(workspaceId: string, selection: AutomationSelection): string {
  const base = `/w/${encodeURIComponent(workspaceId)}/automations`;
  switch (selection.kind) {
    case 'list':
      return base;
    case 'rule':
      return `${base}?${AUTOMATION_RULE_PARAM}=${encodeURIComponent(selection.ruleId)}`;
    case 'new':
      return selection.scopeItemId === null
        ? `${base}?${AUTOMATION_NEW_PARAM}=1`
        : `${base}?${AUTOMATION_NEW_PARAM}=1&${AUTOMATION_SCOPE_PARAM}=${encodeURIComponent(selection.scopeItemId)}`;
  }
}
