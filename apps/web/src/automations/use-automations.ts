import {
  automations,
  isCanceledError,
  isNixApiError,
  type AutomationRuleResponse as AutomationRule,
  type AutomationRuleInput,
  type AutomationRunResponse as AutomationRun,
  type AutomationTestResponse as AutomationTestResult,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { parseViolations, type Violation } from './automation-draft';

/**
 * The caller's own automation rules in one workspace, and every write the page makes to them.
 *
 * **Writes report back to where the person is looking.** A save, a toggle or a run returns its
 * outcome to the control that asked, the way `use-access-tokens.ts` returns a mint's refusal to its
 * dialog, rather than pushing it into a list-wide error at the other end of the screen.
 *
 * **A stale revision is its own outcome, not an error string.** The editor offers to reload the
 * saved rule when that happens, which is a different action from fixing a field.
 */

export type AutomationsStatus = 'loading' | 'ready' | 'error';

export type SaveOutcome =
  | { readonly kind: 'saved'; readonly rule: AutomationRule }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'invalid'; readonly violations: readonly Violation[] }
  | { readonly kind: 'refused'; readonly message: string };

/** A direct read: the rule, a rule that is not there for this caller, or a read that failed. */
export type FetchRuleOutcome =
  | { readonly kind: 'found'; readonly rule: AutomationRule }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error' };

export type RunOutcome =
  | { readonly kind: 'ran'; readonly run: AutomationRun }
  | { readonly kind: 'refused'; readonly message: string };

export type TestOutcome =
  | { readonly kind: 'tested'; readonly result: AutomationTestResult }
  | { readonly kind: 'refused'; readonly message: string };

export interface AutomationsState {
  readonly status: AutomationsStatus;
  readonly rules: readonly AutomationRule[];
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  /** Reads one rule afresh, bypassing the cache - after a conflict, say. */
  readonly fetchRule: (ruleId: string) => Promise<FetchRuleOutcome>;
  readonly create: (input: AutomationRuleInput) => Promise<SaveOutcome>;
  readonly update: (rule: AutomationRule, input: AutomationRuleInput) => Promise<SaveOutcome>;
  readonly remove: (rule: AutomationRule) => Promise<{ readonly refusal: string | null }>;
  readonly run: (ruleId: string, itemId: string | null) => Promise<RunOutcome>;
  readonly test: (ruleId: string, itemId: string | null) => Promise<TestOutcome>;
}

const OFFLINE = 'The request could not be sent. Check your connection and try again.';

function saveFailure(cause: unknown): SaveOutcome {
  if (!isNixApiError(cause)) return { kind: 'refused', message: OFFLINE };
  if (cause.status === 409 || cause.code === 'automation.conflict') {
    return {
      kind: 'conflict',
      message:
        cause.detail ?? 'This automation changed since you opened it. Reload it before saving.',
    };
  }
  if (cause.code === 'automation.invalid' && cause.detail !== undefined) {
    return { kind: 'invalid', violations: parseViolations(cause.detail) };
  }
  if (cause.code === 'automation.not_found' || cause.status === 404) {
    return {
      kind: 'refused',
      message: 'This automation no longer exists. It may have been deleted.',
    };
  }
  if (cause.status === 403) {
    return { kind: 'refused', message: 'You cannot change automations in this workspace.' };
  }
  return {
    kind: 'refused',
    message:
      cause.detail ??
      (cause.status === undefined
        ? OFFLINE
        : `The automation could not be saved (${String(cause.status)}).`),
  };
}

function refusalOf(cause: unknown, fallback: string): string {
  if (!isNixApiError(cause)) return OFFLINE;
  if (cause.code === 'automation.not_found' || cause.status === 404) {
    return 'This automation no longer exists. It may have been deleted.';
  }
  if (cause.status === 403) return 'You cannot do that in this workspace.';
  return (
    cause.detail ??
    (cause.status === undefined ? OFFLINE : `${fallback} (${String(cause.status)}).`)
  );
}

export function useAutomations(workspaceId: string): AutomationsState {
  const client = useApiClient();
  const [status, setStatus] = useState<AutomationsStatus>('loading');
  const [rules, setRules] = useState<readonly AutomationRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setStatus('loading');
      setError(null);
      try {
        const loaded = await client.query(automations.list(workspaceId), {
          signal,
          forceRefresh: true,
        });
        if (signal?.aborted === true) return;
        setRules(loaded.items);
        setStatus('ready');
      } catch (cause) {
        if (signal?.aborted === true || isCanceledError(cause)) return;
        console.warn('The automation list read failed.', cause);
        setError(
          isNixApiError(cause) && cause.status !== undefined
            ? `Your automations could not be loaded (${String(cause.status)}).`
            : 'Your automations could not be loaded. Check your connection and try again.',
        );
        setStatus('error');
      }
    },
    [client, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, [load]);

  /** Replaces or adds one rule in place, so a save does not flash the whole list back to loading. */
  const upsert = useCallback((rule: AutomationRule): void => {
    setRules((current) =>
      current.some((entry) => entry.id === rule.id)
        ? current.map((entry) => (entry.id === rule.id ? rule : entry))
        : [...current, rule],
    );
  }, []);

  const signal = (): AbortSignal | undefined => lifetime.current?.signal;

  return {
    status,
    rules,
    error,
    reload: () => load(signal()),
    fetchRule: async (ruleId) => {
      try {
        const fresh = await client.query(automations.get(ruleId), {
          signal: signal(),
          forceRefresh: true,
        });
        // A rule from another of the caller's workspaces is not this page's to show.
        if (fresh.workspaceId !== workspaceId) return { kind: 'missing' };
        upsert(fresh);
        return { kind: 'found', rule: fresh };
      } catch (cause) {
        if (isNixApiError(cause) && cause.status === 404) return { kind: 'missing' };
        if (!isCanceledError(cause)) console.warn('The automation read failed.', cause);
        return { kind: 'error' };
      }
    },
    create: async (input) => {
      try {
        const created = await client.execute(automations.create(workspaceId, input), {
          signal: signal(),
        });
        upsert(created);
        return { kind: 'saved', rule: created };
      } catch (cause) {
        return saveFailure(cause);
      }
    },
    update: async (rule, input) => {
      try {
        const saved = await client.execute(automations.update(rule.id, rule.revision, input), {
          signal: signal(),
        });
        upsert(saved);
        return { kind: 'saved', rule: saved };
      } catch (cause) {
        return saveFailure(cause);
      }
    },
    remove: async (rule) => {
      try {
        await client.execute(automations.remove(rule.id), { signal: signal() });
        setRules((current) => current.filter((entry) => entry.id !== rule.id));
        return { refusal: null };
      } catch (cause) {
        return { refusal: refusalOf(cause, 'The automation could not be deleted') };
      }
    },
    run: async (ruleId, itemId) => {
      try {
        const run = await client.execute(automations.run(ruleId, itemId), { signal: signal() });
        return { kind: 'ran', run };
      } catch (cause) {
        return { kind: 'refused', message: refusalOf(cause, 'The automation could not be run') };
      }
    },
    test: async (ruleId, itemId) => {
      try {
        const result = await client.execute(automations.dryRun(ruleId, itemId), {
          signal: signal(),
        });
        return { kind: 'tested', result };
      } catch (cause) {
        return { kind: 'refused', message: refusalOf(cause, 'The automation could not be tested') };
      }
    },
  };
}

export interface AutomationRunsState {
  readonly status: AutomationsStatus;
  readonly runs: readonly AutomationRun[];
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  readonly reload: () => void;
}

/** A rule's run log, newest first, one page at a time. */
export function useAutomationRuns(ruleId: string): AutomationRunsState {
  const client = useApiClient();
  const [status, setStatus] = useState<AutomationsStatus>('loading');
  const [runs, setRuns] = useState<readonly AutomationRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [generation, setGeneration] = useState(0);
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setStatus('loading');
      setError(null);
      void client
        .query(automations.runs(ruleId), { signal: controller.signal, forceRefresh: true })
        .then((page) => {
          if (controller.signal.aborted) return;
          setRuns(page.items);
          setCursor(page.nextCursor);
          setStatus('ready');
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || isCanceledError(cause)) return;
          setError('The run log could not be loaded. Check your connection and try again.');
          setStatus('error');
        });
    });
    return () => {
      controller.abort();
    };
  }, [client, ruleId, generation]);

  return {
    status,
    runs,
    error,
    hasMore: cursor !== null,
    loadingMore,
    reload: () => {
      setGeneration((current) => current + 1);
    },
    loadMore: () => {
      const controller = lifetime.current;
      if (cursor === null || loadingMore || controller === null) return;
      setLoadingMore(true);
      void client
        .query(automations.runs(ruleId, cursor), { signal: controller.signal, forceRefresh: true })
        .then((page) => {
          if (controller.signal.aborted) return;
          setRuns((current) => [...current, ...page.items]);
          setCursor(page.nextCursor);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || isCanceledError(cause)) return;
          setError('More runs could not be loaded. Try again.');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingMore(false);
        });
    },
  };
}
