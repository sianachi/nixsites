import {
  isCanceledError,
  principal as principalResource,
  type CurrentPrincipal,
} from '@nix/api-client';
import { useEffect, useMemo, useState } from 'react';

import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { isFilterGroup, type ViewFilterRule } from './container-model';
import { ME_TOKEN, type RuleContext } from './filter-rules';
import { readerToday } from './timestamps';

const PRINCIPAL_KEY = ['me'] as const;

/**
 * Who `me` is, as far as this screen knows: still being asked, could not be answered, or known.
 *
 * Three states rather than a nullable id, because the two kinds of "no id" call for different
 * screens. While the answer is on its way a rule about the reader cannot be evaluated yet, and
 * showing what it would admit with nobody in `me` flashes an empty view. Once the question has
 * failed it never will be, and hiding every item over a rule nobody could check is a filter with
 * no visible reason.
 */
type PrincipalId = 'loading' | 'failed' | { readonly id: string };

/** The rule context, and how far the reader's identity has got. */
export interface ReaderRuleContext {
  readonly context: RuleContext;

  /** Whether any rule names `me`, and so whether {@link principal} matters at all. */
  readonly needsPrincipal: boolean;

  readonly principal: PrincipalId;
}

/** Whether a rule reads the reader's identity. */
export function namesReader(rule: ViewFilterRule): boolean {
  return isFilterGroup(rule)
    ? rule.any.some((condition) => condition.value === ME_TOKEN)
    : rule.value === ME_TOKEN;
}

/**
 * What the client-side rules need from outside the item: the reader's day, and who `me` is.
 *
 * **The principal is only asked for when a rule says `me`.** Every container view evaluates rules,
 * and most never name a person; a request per view mount for an answer nothing reads is a request
 * the shell has usually already made, so the cached answer is read first and the network is the
 * fallback.
 */
export function useRuleContext(rules: readonly ViewFilterRule[]): ReaderRuleContext {
  // Optional, because a view rendered with no client above it - a story, a component test - still
  // evaluates every rule but `me`, which then cannot be answered and is reported as such.
  const client = useOptionalApiClient();
  const needsPrincipal = rules.some(namesReader);

  const [principal, setPrincipal] = useState<PrincipalId>(() => {
    const cached = client?.cache.peek<CurrentPrincipal>(PRINCIPAL_KEY)?.data.id;
    if (cached !== undefined) return { id: cached };
    return client === null ? 'failed' : 'loading';
  });

  useEffect(() => {
    if (client === null || !needsPrincipal || principal !== 'loading') return;

    const controller = new AbortController();
    client
      .query(principalResource.currentPrincipal(), { signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted) setPrincipal({ id: loaded.id });
      })
      .catch((reason: unknown) => {
        // Cancellation is the unmount, not a failure.
        if (!isCanceledError(reason)) setPrincipal('failed');
      });

    return () => {
      controller.abort();
    };
  }, [client, needsPrincipal, principal]);

  // The day is read per render and memoised by its text, so the context's identity - an input to
  // the filter pipeline - only changes when the date does.
  const today = readerToday();
  const principalId = typeof principal === 'object' ? principal.id : null;
  const context = useMemo(() => ({ today, principalId }), [today, principalId]);
  return { context, needsPrincipal, principal };
}
