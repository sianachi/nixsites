import { Button, Checkbox, ContextMenu, Icon, Menu, Text, cn, focusRing } from '@nix/ui';
import { Ellipsis, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { inferFilters, type InferredFilters } from '@nix/web-foundation/lib/suggest/infer-filters';
import { useItemOpenProps } from '../core/item-open-click';
import {
  applyTitleSearch,
  isFilterGroup,
  readPropertyText,
  type ViewFilterRule,
} from '../core/container-model';
import { useViewState } from '../core/view-state';
import { ruleConditions } from '../core/filter-rules';
import type { ViewRendererProps } from '../core/view-kinds';
import { useHiddenItems } from '../../items/use-hidden-items';
import { editableDefinition, QueryRowValue } from './query-row-values';
import { useRowSchemas } from './use-row-schemas';
import { useQueryResults } from './use-query-results';

/** Loaded once somebody asks for suggested filters; most visits to a smart list never do. */
const QueryByExamplePanel = lazy(() => import('./query-by-example'));

/**
 * The query view: a smart list's matches, run server-side, drawn as rows that say where they live.
 *
 * The second kind whose data is not the container's children - its rows come from
 * `GET /items/{id}/query`, which compiles the view's stored filters over every container the
 * reader may see. `container.children` is deliberately ignored, and so is `useViewChrome`,
 * whose filter/sort/empty branches are statements about children this view does not draw; the
 * five states are answered here instead, from the run's own honesty fields.
 *
 * Server-ordered, no client sort: the rows were cut by a limit in the statement's order, and a
 * client re-sort of a truncated list would claim an order the full set does not have.
 *
 * **Query by example.** "Suggest filters from examples" turns each row into something that can be
 * ticked; "Suggest filters" then asks `lib/suggest/infer-filters.ts` what the ticked rows share that
 * the other rows on screen mostly do not, and drops the answer into the filter editor as a draft
 * (`query-by-example.tsx`). Only saving that draft changes the smart list, through the same view
 * write every other view configuration takes. The shared workspace invalidation refreshes the
 * run after the saved view changes.
 */
export function QueryView(props: ViewRendererProps): ReactNode {
  const { container, view, onOpen } = props;
  const openProps = useItemOpenProps(onOpen);
  const visibility = useHiddenItems();
  const viewState = useViewState();

  // The itemId this view runs against is the smart list itself - the container's own id, not its
  // children. Every child the container may incidentally hold stays untouched by this view.
  const run = useQueryResults(container.itemId ?? '', view.id);
  const rowSchemas = useRowSchemas(
    (run.results?.results ?? []).flatMap((row) =>
      row.containerId === null ? [] : [row.containerId],
    ),
  );

  // Query by example: whether rows can be ticked, which ones are, and the proposal under review.
  // All of it is a gesture in progress on this screen, so it is local state and nothing else.
  const [picking, setPicking] = useState(false);
  const [examples, setExamples] = useState<ReadonlySet<string>>(new Set());
  const [proposal, setProposal] = useState<{
    readonly inferred: InferredFilters;
    readonly examples: number;
    readonly draft: readonly ViewFilterRule[];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function stopPicking(): void {
    setPicking(false);
    setExamples(new Set());
    setProposal(null);
    setSaveError(null);
  }

  async function saveProposal(draft: readonly ViewFilterRule[]): Promise<void> {
    if (saving) {
      return;
    }
    const stored = container.views?.views ?? [];
    setSaving(true);
    setSaveError(null);
    const refusal = await container.setViews(
      stored.map((candidate) =>
        candidate.id === view.id ? { ...candidate, filters: [...draft] } : candidate,
      ),
    );
    setSaving(false);
    if (refusal !== null) {
      setSaveError(refusal);
      return;
    }
    stopPicking();
  }

  if (run.status === 'loading') {
    return <LoadingPanel label="this smart list" />;
  }

  if (run.status === 'error' || run.results === null) {
    return (
      <ErrorPanel
        title="This smart list could not be run"
        detail={run.error ?? 'The query could not be read.'}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              void run.reload();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  const { results } = run;
  const schema = container.schema?.properties ?? [];
  const unhidden = results.results.filter((item) => !visibility.hiddenSet.has(item.id));
  const visible = applyTitleSearch(unhidden, viewState.search);

  if (results.results.length === 0) {
    return (
      <EmptyPanel
        title="Nothing matches today"
        // "Today", because a smart list's emptiness is relative: the same list may fill tomorrow
        // without anybody touching an item. "Nothing in here yet" would send somebody looking for
        // deleted items.
        detail="No item the filters match is visible to you right now. The list refills as items change."
      />
    );
  }

  function suggestFromExamples(): void {
    const rows = visible.map((candidate) => ({
      id: candidate.id,
      properties: candidate.properties,
    }));
    const chosen = rows.filter((candidate) => examples.has(candidate.id));
    const inferred = inferFilters(chosen, rows);
    // Appended to what the list already asks, skipping a proposed rule it already has: the
    // examples were drawn from rows the existing rules matched, so those rules still hold.
    // Only the plain conditions: one inside an "any of" group need not hold for every row.
    const existing = new Set(
      view.filters
        .filter((rule) => !isFilterGroup(rule))
        .map((rule) => `${rule.property}\u0000${rule.operator}\u0000${rule.value}`),
    );
    const added = inferred.rules
      .map((rule) => ({ property: rule.property, operator: rule.operator, value: rule.value }))
      .filter((rule) => !existing.has(`${rule.property}\u0000${rule.operator}\u0000${rule.value}`));
    setSaveError(null);
    setProposal({ inferred, examples: chosen.length, draft: [...view.filters, ...added] });
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" aria-busy={run.refreshing}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          aria-pressed={picking}
          onClick={() => {
            if (picking) {
              stopPicking();
            } else {
              setPicking(true);
            }
          }}
        >
          Suggest filters from examples
        </Button>
        {picking ? (
          <>
            <Text
              variant="note"
              tone="muted"
              as="span"
              className="min-w-0 max-w-full wrap-anywhere"
            >
              {examples.size === 0
                ? 'Tick the items this list is meant to hold.'
                : `${String(examples.size)} ${examples.size === 1 ? 'example' : 'examples'} ticked.`}
            </Text>
            <Button
              variant="secondary"
              aria-disabled={examples.size === 0}
              onClick={() => {
                if (examples.size > 0) {
                  suggestFromExamples();
                }
              }}
            >
              Suggest filters
            </Button>
          </>
        ) : null}
      </div>

      {proposal === null ? null : (
        <Suspense
          fallback={
            <Text variant="note" tone="muted" as="p">
              Loading suggested filters…
            </Text>
          }
        >
          <QueryByExamplePanel
            examples={proposal.examples}
            inferred={proposal.inferred}
            truncated={results.truncated}
            draft={proposal.draft}
            schema={schema}
            onDraftChange={(draft) => {
              setProposal({ ...proposal, draft });
            }}
            saving={saving}
            error={saveError}
            onSave={() => {
              void saveProposal(proposal.draft);
            }}
            onDiscard={() => {
              setProposal(null);
              setSaveError(null);
            }}
          />
        </Suspense>
      )}

      {run.refreshError === null ? null : (
        <div role="alert" className="flex items-start gap-2 border border-divider p-3">
          <Icon icon={TriangleAlert} className="size-4 text-accent-text" />
          <Text variant="note" as="span" tone="accent">
            {run.refreshError} These results are unaffected; try again.
          </Text>
        </div>
      )}

      {results.truncated ? (
        <PartialNotice
          pending={`More items match than this list carries: the first ${String(results.results.length)} were loaded.`}
        />
      ) : null}

      {unhidden.length < results.results.length ? (
        <Text variant="caption" tone="muted" role="status">
          {String(results.results.length - unhidden.length)} hidden
        </Text>
      ) : null}
      {unhidden.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <Text variant="note" tone="muted">
            All matches are hidden for you.
          </Text>
          <Button
            variant="ghost"
            onClick={() => {
              visibility.showItems(results.results.map((row) => row.id));
            }}
          >
            Show these results
          </Button>
        </div>
      ) : null}
      {visible.length === unhidden.length ? null : (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <Text variant="note" tone="muted">
            {visible.length === 0
              ? 'No loaded results match this title search. Clear the search above to see them.'
              : `${String(visible.length)} of ${String(unhidden.length)} loaded results match this title search.`}
          </Text>
        </div>
      )}
      <ul className="flex flex-col">
        {visible.map((row) => {
          const owner = { title: row.title ?? '', properties: row.properties };

          return (
            <ContextMenu
              key={row.id}
              label={`Actions for ${row.title ?? 'Untitled'}`}
              items={[
                {
                  label: 'Open',
                  onSelect: () => {
                    onOpen(row.id);
                  },
                },
                {
                  label: 'Hide for me',
                  onSelect: () => {
                    visibility.hide(row.id, row.title ?? 'Untitled');
                  },
                },
              ]}
            >
              {(target) => (
                <li
                  {...target}
                  className="flex min-w-0 items-start gap-2 border-b border-divider py-2 sm:gap-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-start gap-2">
                      {picking ? (
                        <Checkbox
                          aria-label={`Use ${row.title ?? 'Untitled'} as an example`}
                          checked={examples.has(row.id)}
                          onChange={(event) => {
                            const next = new Set(examples);
                            if (event.target.checked) {
                              next.add(row.id);
                            } else {
                              next.delete(row.id);
                            }
                            setExamples(next);
                          }}
                        />
                      ) : null}
                      <button
                        type="button"
                        {...openProps(row.id)}
                        className={cn(
                          'min-w-0 flex-1 cursor-default wrap-anywhere text-left font-semibold hover:text-accent-text any-pointer-coarse:min-h-(--control-lg)',
                          focusRing,
                        )}
                      >
                        {row.title ?? 'Untitled'}
                      </button>
                    </div>
                    {row.containerTitle === null ? null : (
                      <Text
                        variant="note"
                        tone="muted"
                        as="span"
                        className="min-w-0 max-w-full wrap-anywhere"
                      >
                        in {row.containerTitle}
                      </Text>
                    )}

                    {/* The values the query matched on, so a row says why it is here, each
                      editable in place. A property the row's own container does not declare reads as text. */}
                    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                      {[...new Set(ruleConditions(view.filters).map((rule) => rule.property))].map(
                        (key) => {
                          const definition = editableDefinition(
                            (row.containerId === null
                              ? undefined
                              : rowSchemas.get(row.containerId)) ?? [],
                            key,
                          );
                          const text = readPropertyText(owner, key);
                          return definition !== undefined ? (
                            <QueryRowValue
                              key={key}
                              itemId={row.id}
                              title={owner.title}
                              properties={row.properties}
                              property={definition}
                              onSaved={() => {
                                void run.reload();
                              }}
                            />
                          ) : text.length === 0 ? null : (
                            <Text
                              key={key}
                              variant="note"
                              tone="muted"
                              as="span"
                              lines={2}
                              className="min-w-0 max-w-full whitespace-pre-line wrap-anywhere px-2"
                            >
                              {text}
                            </Text>
                          );
                        },
                      )}
                    </div>
                  </div>
                  <Menu
                    label={`Actions for ${row.title ?? 'Untitled'}`}
                    items={[
                      {
                        kind: 'action',
                        label: 'Hide for me',
                        onSelect: () => {
                          visibility.hide(row.id, row.title ?? 'Untitled');
                        },
                      },
                    ]}
                  >
                    {(trigger) => (
                      <Button
                        {...trigger}
                        variant="ghost"
                        className="shrink-0"
                        aria-label={`Actions for ${row.title ?? 'Untitled'}`}
                      >
                        <Icon icon={Ellipsis} size="sm" />
                      </Button>
                    )}
                  </Menu>
                </li>
              )}
            </ContextMenu>
          );
        })}
      </ul>
    </div>
  );
}
