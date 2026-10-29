import type { AutomationRuleResponse as AutomationRule } from '@nix/api-client';
import { Button, Text, cn, focusRing } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { draftFromRule, emptyDraft, ruleInputFromDraft } from './automation-draft';
import { AutomationDetail } from './automation-detail';
import { AutomationList } from './automation-list';
import {
  automationsHref,
  parseAutomationSelection,
} from '@nix/web-collections/items/automation-url';
import { useAutomations, type AutomationsState } from './use-automations';

/**
 * The caller's automations in this workspace (ADR-0051 section 6): the list, one rule's editor and
 * run log, or a new rule - whichever the address names, so each is a place that survives a refresh.
 *
 * Rules are private to their owner. Other members, workspace owners included, never see these,
 * which the page says once so nobody wonders why a colleague's rules are missing.
 */
export function AutomationsPage(): ReactNode {
  const { workspaceId } = useWorkspace();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const selection = parseAutomationSelection(params);
  const state = useAutomations(workspaceId);

  const listHref = automationsHref(workspaceId, { kind: 'list' });
  const itemHref = (itemId: string): string =>
    `/w/${encodeURIComponent(workspaceId)}?item=${encodeURIComponent(itemId)}`;

  return (
    <div className={`${paneScroller} flex min-w-0 flex-col`}>
      <header className="border-b border-divider p-3 sm:p-5">
        <Text variant="h4" as="h1">
          Automations
        </Text>
        <Text variant="note" tone="muted" className="mt-2 max-w-2xl">
          Rules that act for you on a schedule, when a date arrives, or when a property changes.
          They are yours alone: nobody else in the workspace can see or change them.
        </Text>
      </header>

      <div className="flex min-w-0 max-w-4xl flex-col gap-4 p-3 sm:p-5">
        {selection.kind === 'list' ? (
          <ListView state={state} workspaceId={workspaceId} />
        ) : (
          <>
            <div>
              <Link to={listHref} className={cn('underline', focusRing)}>
                <Text as="span" variant="note" tone="accent">
                  Back to all automations
                </Text>
              </Link>
            </div>
            {selection.kind === 'new' ? (
              <AutomationDetail
                workspaceId={workspaceId}
                state={state}
                rule={null}
                initialDraft={emptyDraft(selection.scopeItemId)}
                itemHref={itemHref}
                onSaved={(rule) => {
                  publishNotice({ key: 'automation-saved', message: `${rule.name} was created.` });
                  void navigate(automationsHref(workspaceId, { kind: 'rule', ruleId: rule.id }), {
                    replace: true,
                  });
                }}
                onDeleted={() => undefined}
                onClose={() => {
                  void navigate(listHref);
                }}
              />
            ) : (
              <RuleView
                key={selection.ruleId}
                ruleId={selection.ruleId}
                state={state}
                workspaceId={workspaceId}
                itemHref={itemHref}
                onClose={() => {
                  void navigate(listHref);
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ListView({
  state,
  workspaceId,
}: {
  readonly state: AutomationsState;
  readonly workspaceId: string;
}): ReactNode {
  const navigate = useNavigate();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [toggleErrors, setToggleErrors] = useState<Readonly<Record<string, string>>>({});
  const newHref = automationsHref(workspaceId, { kind: 'new', scopeItemId: null });

  async function toggle(rule: AutomationRule, enabled: boolean): Promise<void> {
    const draft = draftFromRule(rule);
    if (draft === null) return;
    setPending((current) => new Set([...current, rule.id]));
    setToggleErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== rule.id)),
    );
    const outcome = await state.update(rule, ruleInputFromDraft({ ...draft, enabled }));
    setPending((current) => new Set([...current].filter((id) => id !== rule.id)));
    if (outcome.kind === 'saved') return;
    if (outcome.kind === 'conflict') void state.fetchRule(rule.id);
    setToggleErrors((current) => ({
      ...current,
      [rule.id]:
        outcome.kind === 'conflict'
          ? 'It changed elsewhere, so the latest version was loaded. Try again.'
          : outcome.kind === 'invalid'
            ? 'It could not be changed here. Open it to fix what is wrong.'
            : outcome.message,
    }));
  }

  return (
    <section aria-label="Automations" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text variant="h5" as="h2">
          Your automations
        </Text>
        <Button
          onClick={() => {
            void navigate(newHref);
          }}
        >
          New automation
        </Button>
      </div>
      {state.status === 'loading' && state.rules.length === 0 ? (
        <LoadingPanel label="your automations" />
      ) : null}
      {state.status === 'error' ? (
        <ErrorPanel
          title="Your automations could not be loaded"
          detail={state.error ?? 'Something went wrong reading your automations.'}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void state.reload();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : null}
      {state.status === 'ready' && state.rules.length === 0 ? (
        <EmptyPanel
          title="No automations yet"
          detail="Create one to get a reminder on a schedule, act when a due date comes near, or update an item when another property changes."
        />
      ) : null}
      {state.rules.length > 0 ? (
        <AutomationList
          rules={state.rules}
          hrefFor={(rule) => automationsHref(workspaceId, { kind: 'rule', ruleId: rule.id })}
          onToggle={(rule, enabled) => {
            void toggle(rule, enabled);
          }}
          pending={pending}
          toggleErrors={toggleErrors}
        />
      ) : null}
    </section>
  );
}

function RuleView({
  ruleId,
  state,
  workspaceId,
  itemHref,
  onClose,
}: {
  readonly ruleId: string;
  readonly state: AutomationsState;
  readonly workspaceId: string;
  readonly itemHref: (itemId: string) => string;
  readonly onClose: () => void;
}): ReactNode {
  const navigate = useNavigate();
  const fromList = state.rules.find((rule) => rule.id === ruleId) ?? null;
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'missing' | 'error'>('idle');

  // A link straight to a rule arrives before the list has loaded, or names one the list does not
  // hold; one direct read settles which.
  const listSettled = state.status !== 'loading';
  useEffect(() => {
    if (fromList !== null || !listSettled || lookup !== 'idle') return;
    queueMicrotask(() => {
      setLookup('loading');
      void state.fetchRule(ruleId).then((outcome) => {
        setLookup(outcome.kind === 'found' ? 'idle' : outcome.kind);
      });
    });
  }, [fromList, listSettled, lookup, ruleId, state]);

  if (fromList === null) {
    if (lookup === 'missing') {
      return (
        <ErrorPanel
          title="This automation is not available"
          detail="It may have been deleted, or it belongs to someone else. Automations are visible only to the person who made them."
          action={
            <Button variant="secondary" onClick={onClose}>
              See your automations
            </Button>
          }
        />
      );
    }
    if (lookup === 'error') {
      return (
        <ErrorPanel
          title="This automation could not be loaded"
          detail="Check your connection and try again."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setLookup('idle');
              }}
            >
              Try again
            </Button>
          }
        />
      );
    }
    return <LoadingPanel label="the automation" />;
  }

  return (
    <AutomationDetail
      workspaceId={workspaceId}
      state={state}
      rule={fromList}
      initialDraft={null}
      itemHref={itemHref}
      onSaved={(rule) => {
        publishNotice({ key: 'automation-saved', message: `${rule.name} was saved.` });
      }}
      onDeleted={(rule) => {
        publishNotice({ key: 'automation-deleted', message: `${rule.name} was deleted.` });
        void navigate(automationsHref(workspaceId, { kind: 'list' }), { replace: true });
      }}
      onClose={onClose}
    />
  );
}
