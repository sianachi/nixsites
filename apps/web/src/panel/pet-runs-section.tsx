import {
  automations,
  isNixApiError,
  petRuns,
  search,
  type NixClient,
  type PetRunAbility,
  type PetRunResponse,
  type SearchHit,
} from '@nix/api-client';
import { Button, Checkbox, Field, Input, Text, focusRing } from '@nix/ui';
import type {
  ConversationJobDraft,
  ConversationJobMessage,
  ConversationJobs,
} from '@nix/web-pets/pets/conversation/conversation-jobs';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { isPetJobMessage } from './pet-job-message';
import { PetPeerSection } from './pet-peer-section';
import { PetRunCard, PetRunStatusTag } from './pet-run-card';
import { PetRoutines, RoutineFields, routineDraft } from './pet-routines';
import { usePetRunFeed } from './use-pet-run-feed';

const maxSources = 24;
const maxBriefLength = 4_000;

const abilityLabels = new Map([
  ['task.comment', 'Post a comment'],
  ['task.rename', 'Rename the task'],
  ['nix.action', 'Work with Nix content'],
  ['canvas.edit', 'Edit a canvas'],
  ['canvas.read', 'Read a canvas'],
  ['sheet.edit', 'Edit a sheet'],
  ['browser.search', 'Search the web'],
  ['browser.browse', 'Browse websites'],
  ['browser.submitForm', 'Submit a website form'],
  ['connection.catalog', 'Find connected resources'],
  ['connection.action', 'Use a connected service'],
  ['peer.delegate', 'Hand off work to an agent'],
  ['peer.read_result', 'Read an agent’s result'],
  ['peer.share_result', 'Share a result with an agent'],
]);

interface Source {
  readonly id: string;
  readonly title: string | null;
  readonly type: string;
}

interface JobScope {
  readonly sources: readonly Source[];
  readonly includeTargetText: boolean;
  readonly workspaceScope: boolean;
}

const itemOnly: JobScope = { sources: [], includeTargetText: false, workspaceScope: false };

interface PetDialogJobsInput {
  readonly workspaceId: string;
  readonly itemId: string | null;
  readonly itemTitle?: string | null | undefined;
  readonly itemType?: string | undefined;
  readonly activeRunId?: string | undefined;
  readonly activeDecisionId?: string | undefined;
  readonly showTimeline?: boolean | undefined;
  readonly onStartForItem?: ((run: PetRunResponse) => void) | undefined;
  readonly onItemChanged?: ((id: string) => void) | undefined;
}

interface PetDialogJobs extends ConversationJobs {
  readonly enabled: boolean;
}

export function usePetDialogJobs({
  workspaceId,
  itemId,
  itemTitle,
  itemType,
  activeRunId,
  activeDecisionId,
  showTimeline = true,
  onStartForItem,
  onItemChanged,
}: PetDialogJobsInput): PetDialogJobs {
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [needsTarget, setNeedsTarget] = useState<ConversationJobMessage | null>(null);
  const [selectedScope, setSelectedScope] = useState<{ itemId: string; scope: JobScope } | null>(
    null,
  );
  const [quote, setQuote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const startPending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const target =
    itemId === null ? null : { id: itemId, title: itemTitle ?? null, type: itemType ?? '' };
  const scope =
    selectedScope !== null && selectedScope.itemId === itemId ? selectedScope.scope : itemOnly;
  const { client, feed, update, retry } = usePetRunFeed(
    itemId === null ? 'workspace' : 'item',
    itemId ?? workspaceId,
    showTimeline ? activeRunId : undefined,
    onItemChanged,
  );
  const enabled = feed.status === 'ready' && feed.data.enabled;
  const availabilityKnown = feed.status === 'ready' || feed.status === 'unavailable';
  const runs =
    showTimeline && itemId !== null && feed.status === 'ready'
      ? [...feed.data.runs].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        )
      : [];
  const timeline =
    client === null
      ? []
      : runs.map((run) => ({
          id: run.id,
          ...(run.afterMessageId == null ? {} : { afterMessageId: run.afterMessageId }),
          content: (
            <JobEntry
              run={run}
              client={client}
              onUpdate={update}
              active={(activeRunId ?? startedRunId) === run.id}
              activeDecisionId={activeRunId === run.id ? activeDecisionId : undefined}
            />
          ),
        }));

  function attachMessage(text: string, draft: string): string {
    const excerpt = text
      .split(/\r?\n/)
      .map((line) => (line.length === 0 ? '>' : `> ${line}`))
      .join('\n');
    const next = [draft, excerpt].filter(Boolean).join('\n\n');
    if (!validBrief(next)) {
      setError('This quote would make the message too long for a job. Shorten the message first.');
      return draft;
    }
    setQuote(excerpt);
    setError(null);
    return next;
  }

  function isJob(text: string): boolean {
    return (quote !== null && text.includes(quote)) || isPetJobMessage(text);
  }

  async function start(
    message: ConversationJobMessage,
    destination: Source,
    selection: JobScope,
  ): Promise<void> {
    if (client === null || startPending.current) return;
    startPending.current = true;
    setSending(true);
    setError(null);
    try {
      const run = await client.execute(
        petRuns.start(destination.id, {
          brief: message.text.trim(),
          sourceItemIds: selection.sources.map(({ id }) => id),
          workspaceScope: selection.workspaceScope,
          includeTargetText: destination.type === 'note' && selection.includeTargetText,
          ...(message.afterMessageId === undefined
            ? {}
            : { afterMessageId: message.afterMessageId }),
        }),
      );
      message.onStarted();
      setNeedsTarget(null);
      setSelectedScope(null);
      setQuote(null);
      update(run);
      setStartedRunId(run.id);
      onStartForItem?.(run);
    } catch (reason) {
      setError(
        isNixApiError(reason)
          ? reason.message
          : 'Could not confirm the job started. Check the conversation before trying again.',
      );
    } finally {
      startPending.current = false;
      setSending(false);
    }
  }

  function submit(message: ConversationJobMessage, force?: boolean): boolean {
    if ((force !== true && !isJob(message.text)) || (availabilityKnown && !enabled)) {
      setError(null);
      return false;
    }
    if (startPending.current || needsTarget !== null) return true;
    if (!enabled || client === null) {
      setError('Job availability could not be confirmed. Try again in a moment.');
    } else if (!validBrief(message.text)) {
      const over = message.text.length - maxBriefLength;
      setError(
        over > 0
          ? `This message is ${over.toLocaleString('en')} characters over the ${maxBriefLength.toLocaleString('en')} a job can take. Shorten it to start a job.`
          : 'Shorten the message to start a job.',
      );
    } else if (target === null) {
      setError(null);
      setNeedsTarget(message);
    } else {
      void start(message, target, scope);
    }
    return true;
  }

  return {
    enabled,
    ready: enabled,
    busy: sending || needsTarget !== null,
    canSubmit: (text) => enabled && isJob(text),
    submit,
    timeline,
    ...(enabled ? { attachMessage } : {}),
    panel: (message): ReactNode =>
      client === null || (feed.status === 'loading' && error === null) ? null : (
        <section aria-label="Pet work" className="flex min-w-0 flex-col gap-2">
          {activeRunId !== undefined &&
          (feed.status === 'unavailable' ||
            (feed.status === 'ready' && feed.activeRunUnavailable === true)) ? (
            <Text variant="note" role="status">
              This job is unavailable.
            </Text>
          ) : null}
          {feed.status === 'error' || (feed.status === 'ready' && feed.refreshFailed === true) ? (
            <div className="flex flex-wrap items-center gap-2" role="status">
              <Text variant="note">Could not refresh the jobs.</Text>
              <Button type="button" variant="ghost" onClick={retry}>
                Retry
              </Button>
            </div>
          ) : null}
          {error === null ? null : (
            <Text variant="note" role="alert">
              {error}
            </Text>
          )}
          {sending ? (
            <Text variant="note" role="status">
              Starting job…
            </Text>
          ) : null}
          {needsTarget === null ? null : (
            <>
              <Text variant="bodySmall" role="status">
                Choose an item for this job.
              </Text>
              <SourcePicker
                client={client}
                workspaceId={workspaceId}
                itemId={null}
                sources={[]}
                setSources={([chosen]) => {
                  if (chosen !== undefined && enabled) void start(needsTarget, chosen, itemOnly);
                }}
                disabled={sending}
                limit={1}
                target
              />
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={sending}
                  onClick={() => {
                    setNeedsTarget(null);
                    needsTarget.focusComposer();
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
          {target !== null && availabilityKnown ? (
            <>
              <JobOptions
                key={target.id}
                client={client}
                workspaceId={workspaceId}
                target={target}
                enabled={enabled}
                abilities={feed.status === 'ready' ? feed.data.abilities : []}
                scope={scope}
                onScopeChange={(next) => {
                  setSelectedScope({ itemId: target.id, scope: next });
                }}
                message={message}
                starting={sending}
              />
            </>
          ) : null}
        </section>
      ),
  };
}

function JobEntry({
  client,
  run,
  onUpdate,
  active,
  activeDecisionId,
}: {
  readonly client: NixClient;
  readonly run: PetRunResponse;
  readonly onUpdate: (run: PetRunResponse) => void;
  readonly active: boolean;
  readonly activeDecisionId: string | undefined;
}): ReactElement {
  const region = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [open] = useState(active || (run.status !== 'completed' && run.status !== 'cancelled'));
  const hasDecision =
    activeDecisionId !== undefined &&
    (run.question?.id === activeDecisionId ||
      run.proposals.some(
        (proposal) =>
          proposal.id === activeDecisionId &&
          (proposal.status === 'pending' || proposal.status === 'stale'),
      ));

  useEffect(() => {
    if (!active || region.current === null) return;
    region.current.open = true;
    if (!hasDecision) summary.current?.focus();
  }, [active, activeDecisionId, hasDecision]);

  return (
    <details
      ref={region}
      open={active || open}
      className="min-w-0 rounded-card border border-divider p-3"
    >
      <summary ref={summary} className={`cursor-pointer wrap-anywhere ${focusRing}`} tabIndex={0}>
        <Text as="span" variant="bodySmall">
          {run.brief}
        </Text>
        <PetRunStatusTag status={run.status} className="ms-2" />
      </summary>
      <PetRunCard
        client={client}
        run={run}
        onUpdate={onUpdate}
        hideBrief
        {...(activeDecisionId === undefined ? {} : { activeDecisionId })}
        renderScopeQuestion={(question) => (
          <ScopeQuestion
            key={question.id}
            client={client}
            question={question}
            run={run}
            onUpdate={onUpdate}
          />
        )}
      />
    </details>
  );
}

function ScopeQuestion({
  client,
  question,
  run,
  onUpdate,
}: {
  readonly client: NixClient;
  readonly question: NonNullable<PetRunResponse['question']>;
  readonly run: PetRunResponse;
  readonly onUpdate: (run: PetRunResponse) => void;
}): ReactElement {
  const [selected, setSelected] = useState<readonly Source[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = question.scope === 'source';
  const ability =
    question.ability == null
      ? undefined
      : (abilityLabels.get(question.ability) ?? question.ability);

  async function decide(approve: boolean): Promise<void> {
    if (sending || (approve && source && selected.length === 0)) return;
    setSending(true);
    setError(null);
    try {
      onUpdate(
        await client.execute(
          petRuns.decideScope(
            run.itemId,
            run.id,
            question.id,
            approve,
            approve ? selected[0]?.id : undefined,
          ),
        ),
      );
    } catch (reason) {
      if (isNixApiError(reason) && reason.code === 'pet_runs.invalid') {
        if (source) setSelected([]);
        setError(reason.detail ?? reason.message);
      } else {
        setError('Could not save the access decision. Try again.');
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Text variant="bodySmall">{question.text}</Text>
      {source ? (
        <SourcePicker
          client={client}
          workspaceId={run.workspaceId}
          itemId={null}
          sources={selected}
          setSources={setSelected}
          disabled={sending}
          limit={1}
        />
      ) : ability === undefined ? null : (
        <Text variant="note" tone="muted">
          {ability}
        </Text>
      )}
      {error === null ? null : (
        <Text variant="note" role="alert">
          {error}
        </Text>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={sending || (source && selected.length === 0)}
          onClick={() => void decide(true)}
        >
          {source ? 'Share this source' : 'Allow for this job'}
        </Button>
        <Button type="button" variant="ghost" disabled={sending} onClick={() => void decide(false)}>
          Decline
        </Button>
      </div>
    </div>
  );
}

function validBrief(text: string): boolean {
  return (
    text.trim().length > 0 &&
    text.length <= maxBriefLength &&
    new TextEncoder().encode(text.trim()).length <= 8_000
  );
}

function JobOptions({
  client,
  workspaceId,
  target,
  enabled,
  abilities,
  scope,
  onScopeChange,
  message,
  starting,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly target: Source;
  readonly enabled: boolean;
  readonly abilities: readonly PetRunAbility[];
  readonly scope: JobScope;
  readonly onScopeChange: (scope: JobScope) => void;
  readonly message: ConversationJobDraft;
  readonly starting: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [routine, setRoutine] = useState(() => routineDraft(target.title ?? ''));
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [revision, setRevision] = useState(0);
  const scheduleToggle = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedAbilities = abilities.filter(({ id }) => selected.includes(id));
  const canRename = selectedAbilities.some(({ id }) => id === 'task.rename');
  const disabled = saving || starting;
  const canSave =
    !disabled &&
    validBrief(message.text) &&
    selectedAbilities.length > 0 &&
    routine.name.trim().length > 0 &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(routine.time) &&
    (!routine.autoRename ||
      !canRename ||
      (routine.from.trim().length > 0 &&
        routine.to.trim().length > 0 &&
        routine.from !== routine.to &&
        !/\p{Cc}/u.test(routine.from) &&
        !/\p{Cc}/u.test(routine.to)));

  function refreshRoutines(): void {
    setRevision((prior) => prior + 1);
  }

  async function saveRoutine(): Promise<void> {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setProblem(null);
    setNotice(null);
    try {
      const rule = automations.petRoutineRuleInputSchema.parse({
        name: routine.name.trim(),
        enabled: true,
        scopeItemId: target.id,
        trigger: { type: 'schedule', freq: 'daily', interval: 1, time: routine.time },
        conditions: [],
        actions: [
          {
            type: 'start_pet_run',
            brief: message.text.trim(),
            sourceItemIds: scope.sources.map(({ id }) => id),
            includeTargetText: scope.includeTargetText,
            abilities: selectedAbilities.map(({ id }) => id),
            ...(canRename && routine.autoRename
              ? { autoRename: { from: routine.from, to: routine.to } }
              : {}),
          },
        ],
      });
      await client.execute(automations.create(workspaceId, rule));
      message.onStarted();
      scheduleToggle.current?.focus();
      onScopeChange(itemOnly);
      setScheduled(false);
      setSelected([]);
      setRoutine(routineDraft(target.title ?? ''));
      setNotice(`Saved routine “${rule.name}”.`);
      refreshRoutines();
    } catch (reason) {
      setProblem(
        isNixApiError(reason) ? reason.message : 'The routine could not be saved. Try again.',
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <details
      className="min-w-0"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className={`cursor-pointer ${focusRing}`}>
        <Text as="span" variant="bodySmall">
          Job options
        </Text>
      </summary>
      {open ? (
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          {enabled ? (
            <>
              <SourcePicker
                client={client}
                itemId={target.id}
                workspaceId={workspaceId}
                sources={scope.sources}
                setSources={(sources) => {
                  onScopeChange({ ...scope, sources });
                }}
                disabled={disabled}
              />
              {target.type === 'note' ? (
                <Checkbox
                  label={scheduled ? 'Include note text in each run' : 'Include note text'}
                  checked={scope.includeTargetText}
                  disabled={disabled}
                  onChange={(event) => {
                    onScopeChange({ ...scope, includeTargetText: event.target.checked });
                  }}
                />
              ) : null}
              {!scheduled ? (
                <Checkbox
                  label="Use the whole workspace"
                  checked={scope.workspaceScope}
                  disabled={disabled}
                  onChange={(event) => {
                    onScopeChange({ ...scope, workspaceScope: event.target.checked });
                  }}
                />
              ) : null}
              {target.type === 'note' ? (
                <>
                  <Checkbox
                    ref={scheduleToggle}
                    label="Schedule this job daily"
                    checked={scheduled}
                    disabled={disabled}
                    onChange={(event) => {
                      setScheduled(event.target.checked);
                      if (event.target.checked && scope.workspaceScope) {
                        onScopeChange({ ...scope, workspaceScope: false });
                      }
                    }}
                  />
                  {scheduled ? (
                    <>
                      <fieldset aria-label="Abilities" className="flex min-w-0 flex-col gap-1">
                        {abilities.map((ability) => (
                          <Checkbox
                            key={ability.id}
                            label={abilityLabels.get(ability.id) ?? ability.name}
                            checked={selected.includes(ability.id)}
                            disabled={
                              disabled || (selected.length >= 32 && !selected.includes(ability.id))
                            }
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelected((prior) =>
                                checked
                                  ? [...prior, ability.id]
                                  : prior.filter((id) => id !== ability.id),
                              );
                            }}
                          />
                        ))}
                      </fieldset>
                      <RoutineFields
                        draft={routine}
                        onChange={setRoutine}
                        disabled={disabled}
                        canRename={canRename}
                      />
                      <div>
                        <Button
                          type="button"
                          disabled={!canSave}
                          onClick={() => void saveRoutine()}
                        >
                          {saving ? 'Saving routine…' : 'Save routine'}
                        </Button>
                      </div>
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          <PetRoutines
            client={client}
            itemId={target.id}
            workspaceId={workspaceId}
            revision={revision}
          />
          <PetPeerSection itemId={target.id} workEnabled={enabled} />
          {problem === null ? null : (
            <Text variant="note" role="alert">
              {problem}
            </Text>
          )}
          {notice === null ? null : (
            <Text variant="note" role="status">
              {notice}
            </Text>
          )}
        </div>
      ) : null}
    </details>
  );
}

interface SearchState {
  readonly query: string;
  readonly status: 'ready' | 'failed';
  readonly hits: readonly SearchHit[];
}

function SourcePicker({
  client,
  workspaceId,
  itemId,
  sources,
  setSources,
  disabled,
  limit = maxSources,
  target = false,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly itemId: string | null;
  readonly sources: readonly Source[];
  readonly setSources: (sources: readonly Source[]) => void;
  readonly disabled: boolean;
  readonly limit?: number;
  readonly target?: boolean;
}): ReactElement {
  const [searchText, setSearchText] = useState('');
  const [result, setResult] = useState<SearchState | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const query = searchText.trim();
  const relevantResult = result?.query === query ? result : null;
  const available =
    relevantResult?.hits.filter((hit) => !sources.some(({ id }) => id === hit.id)) ?? [];

  useEffect(() => {
    if (target) searchInput.current?.focus();
  }, [target]);

  useEffect(() => {
    if (query.length < 3) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void client
        .query(search.searchItems(query, 25, workspaceId), { signal: controller.signal })
        .then((response) => {
          if (controller.signal.aborted) return;
          setResult({
            query,
            status: 'ready',
            hits: response.results.filter(
              (hit) => hit.workspaceId === workspaceId && hit.id !== itemId,
            ),
          });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ query, status: 'failed', hits: [] });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, itemId, query, workspaceId]);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={target ? 'Find a target' : 'Find a source'}>
        {(control) => (
          <Input
            {...control}
            ref={searchInput}
            type="search"
            value={searchText}
            disabled={disabled || sources.length >= limit}
            onChange={(event) => {
              setSearchText(event.target.value);
            }}
          />
        )}
      </Field>
      {sources.length > 0 ? (
        <ul aria-label="Selected sources" className="flex min-w-0 flex-col gap-1">
          {sources.map((source) => (
            <li key={source.id} className="flex flex-wrap items-center justify-between gap-1">
              <Text variant="note" className="wrap-anywhere">
                {source.title ?? 'Untitled'}
              </Text>
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove source ${source.title ?? 'Untitled'}`}
                disabled={disabled}
                onClick={() => {
                  setSources(sources.filter(({ id }) => id !== source.id));
                  searchInput.current?.focus();
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {query.length < 3 ? null : relevantResult === null ? (
        <Text variant="note" role="status">
          {target ? 'Finding items…' : 'Finding sources…'}
        </Text>
      ) : relevantResult.status === 'failed' ? (
        <Text variant="note" role="status">
          Try another search.
        </Text>
      ) : available.length === 0 ? (
        <Text variant="note" role="status">
          No matching items available to the pet.
        </Text>
      ) : (
        <ul
          aria-label={target ? 'Target matches' : 'Source matches'}
          className="flex min-w-0 flex-col gap-1"
        >
          {available.map((hit) => (
            <li key={hit.id}>
              <Button
                type="button"
                variant="ghost"
                aria-label={`${target ? 'Choose target' : 'Add source'} ${hit.title ?? 'Untitled'}`}
                disabled={disabled || sources.length >= limit}
                onClick={() => {
                  setSources([...sources, { id: hit.id, title: hit.title, type: hit.type }]);
                  setSearchText('');
                  searchInput.current?.focus();
                }}
              >
                {hit.title ?? 'Untitled'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
