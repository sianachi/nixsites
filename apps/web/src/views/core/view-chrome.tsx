import { Button, Text, focusRing } from '@nix/ui';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import {
  applyFilters,
  applyTitleSearch,
  sortItems,
  type Item,
  type View,
  type ViewFilterRule,
} from './container-model';
import { applyRules } from './filter-rules';
import { namesReader, useRuleContext } from './use-rule-context';
import type { ContainerData } from './use-container';
import { viewConfigureHref } from './view-configure-route';
import type { ViewStateControl } from './view-state';

/**
 * The five things every view has to say before it can say anything about items.
 *
 * Loading, could-not-be-read, cannot-be-drawn, genuinely-empty and hidden-by-filters are five
 * different facts, and each of the three views used to answer all five in its own words, in its own
 * order, with its own local panel shapes. Four copies of one decision is four chances for a view to
 * quietly drop a branch - and the branch a view drops is always the same one, because "the filters
 * are hiding everything" is the only one of the five that never happens while you are building it.
 *
 * **A hook, not a component.** What comes back is a node to render or the items to draw, and
 * nothing wraps the caller. A component here would put a landmark of its own inside every view, and
 * the board asserts its region inventory exactly - shared chrome must be invisible in the accessible
 * tree, not merely tidy in the source.
 *
 * **The words stay with the view; only the branching moves.** A board that cannot be drawn and a
 * calendar that cannot be drawn are wrong in different ways and say so in different sentences. This
 * decides *which* of the five holds; the caller says what that means for it.
 *
 * **The drawable payload rides along.** A view usually has one thing it must resolve before it can
 * draw - the board's grouping property, the calendar's date property - and that resolution is also
 * what decides the cannot-be-drawn branch. Handing it back through the result is what lets the
 * caller use it without re-checking something this function has already proved, and without an
 * unreachable branch to satisfy the compiler.
 *
 * Not built on `AsyncSection`: that consumes an `AsyncStatus<T>` no view produces, and adopting it
 * here is more ceremony than the branch it replaces. It is, however, the seam paginated containers
 * should converge on, at which point this function is what gets rewritten rather than every view.
 */

/** A state that has a headline and an explanation - which is all of them worth drawing a panel for. */
export interface ViewChromeMessage {
  readonly title: string;
  readonly detail: string;
}

/**
 * What a view needs resolved before it can draw, or why it cannot be drawn.
 *
 * `undrawable` is a state about the *view's configuration*, not about the data: the items are all
 * still there, and every one of these messages says so. That is why it is reported as an error
 * panel rather than as an empty one.
 */
export type Drawable<TValue> =
  | { readonly kind: 'drawable'; readonly value: TValue }
  | ({ readonly kind: 'undrawable' } & ViewChromeMessage);

export function drawable<TValue>(value: TValue): Drawable<TValue> {
  return { kind: 'drawable', value };
}

export function undrawable<TValue>(message: ViewChromeMessage): Drawable<TValue> {
  return { kind: 'undrawable', ...message };
}

/**
 * Either the chrome to render instead of the view, or the items to render as the view.
 *
 * `notice` is rendered *alongside* the items rather than instead of them: filters live only in the
 * address, so a view showing four of nine items has no other way to say that five are being held
 * back. Null whenever there is nothing being held back.
 */
export type ViewChrome<TValue> =
  | { readonly kind: 'chrome'; readonly node: ReactNode }
  | {
      readonly kind: 'items';
      readonly items: readonly Item[];
      readonly drawable: TValue;
      readonly notice: ReactNode | null;
    };

export interface ViewChromeArgs<TValue> {
  readonly container: ContainerData;
  readonly viewState: ViewStateControl;

  /** How the view names itself mid-sentence: "this board", "this list", "this calendar". */
  readonly subject: string;

  readonly drawable: Drawable<TValue>;

  /** What this view says when the container really is empty, and the way out of it. */
  readonly emptyTitle: string;
  readonly emptyDetail: string;
  readonly emptyAction?: ReactNode;

  /**
   * What this view says when the filters have hidden every item, given how many there are.
   *
   * The count is the whole point of the sentence: "no items match" leaves open the possibility that
   * the container was empty all along, and the number is the proof that it was not.
   */
  readonly filtered: (total: number) => ViewChromeMessage;

  /**
   * The rules stored on the view itself, applied before the address's filters.
   *
   * Required rather than defaulted so a new view kind cannot forget them: a view whose settings say
   * "only open tasks" and whose screen shows every task is the defect this field exists to end.
   */
  readonly savedRules: readonly ViewFilterRule[];

  /**
   * The view being drawn, so a sentence about its saved filters can link to where they are
   * changed. Null for a container drawn with no view configured, which has no saved filters.
   */
  readonly view: Pick<View, 'id' | 'kind'> | null;

  /** How the items are ordered. Null leaves them in the order somebody arranged them by hand. */
  readonly sortBy: string | null;
  readonly descending: boolean;
}

/**
 * The two states every view answers before its subject even exists: still loading, and could not
 * be read.
 *
 * Split out of {@link useViewChrome} for the one view whose subject is not the children - the
 * form draws no items, so the chrome's empty and filtered branches are statements about data it
 * does not show, but a container that has not loaded or could not be read is still a fact it must
 * not paper over. One copy, so a change to how a failed read reports cannot silently miss a view.
 */
export function resolveLoadState(container: ContainerData, subject: string): ReactNode | null {
  if (container.status === 'loading') {
    return <LoadingPanel label={subject} />;
  }

  if (container.status === 'error') {
    return (
      <ErrorPanel
        title={`${capitalise(subject)} could not be loaded`}
        detail={container.error ?? `The contents of ${subject} could not be read.`}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              void container.reload();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  if (container.status === 'partial') {
    return (
      <ErrorPanel
        title={`${capitalise(subject)} is only partially available`}
        detail={container.error ?? `Some configuration for ${subject} could not be read.`}
        action={
          <Button variant="secondary" onClick={() => void container.reload()}>
            Try again
          </Button>
        }
      />
    );
  }

  return null;
}

export function useViewChrome<TValue>(args: ViewChromeArgs<TValue>): ViewChrome<TValue> {
  const { container, viewState } = args;

  // Sorting 3,200 children is measured work, and the returned array's identity is the
  // virtualizer's subscription boundary. Keep both stable across local interaction renders;
  // children, URL filters or the chosen ordering are the only facts that can change the result.
  const reader = useRuleContext(args.savedRules);
  const ruleContext = reader.context;
  const readerUnknown = reader.needsPrincipal && reader.principal === 'failed';
  // A rule about the reader that can never be checked is set aside rather than left to hide
  // everything, and the notice below says so; the rest of the view's rules still apply.
  const savedRules = useMemo(
    () => (readerUnknown ? args.savedRules.filter((rule) => !namesReader(rule)) : args.savedRules),
    [args.savedRules, readerUnknown],
  );
  const saved = useMemo(
    () => applyRules(container.children, savedRules, ruleContext),
    [savedRules, container.children, ruleContext],
  );
  const addressed = useMemo(
    () => applyFilters(saved, viewState.filters, ruleContext),
    [ruleContext, saved, viewState.filters],
  );
  const visible = useMemo(
    () => applyTitleSearch(addressed, viewState.search),
    [addressed, viewState.search],
  );
  const properties = container.schema?.properties;
  const sorted = useMemo(
    () => sortItems(visible, args.sortBy, args.descending, properties),
    [args.descending, args.sortBy, properties, visible],
  );

  const loadState = resolveLoadState(container, args.subject);
  if (loadState !== null) {
    return { kind: 'chrome', node: loadState };
  }

  // A rule naming `me` cannot be evaluated until the reader is known, and evaluating it with
  // nobody in `me` would flash an empty view - or the "filters hide everything" panel - first.
  if (reader.needsPrincipal && reader.principal === 'loading') {
    return { kind: 'chrome', node: <LoadingPanel label={args.subject} /> };
  }

  const configureHref = args.view === null ? null : viewConfigureHref(container.itemId, args.view);
  const changeFilters =
    configureHref === null ? null : (
      <Link
        to={configureHref}
        className={`inline-flex w-fit items-center underline pointer-coarse:min-h-(--control-lg) ${focusRing}`}
      >
        Change this view&apos;s filters
      </Link>
    );

  // Before anything about items: can this be drawn at all? Checked after the two states above, so a
  // view whose schema has not arrived yet is never accused of naming a property that does not
  // exist - it has not been told what exists.
  if (args.drawable.kind === 'undrawable') {
    // A view that cannot be drawn is a configuration problem, so the way out is its settings.
    return {
      kind: 'chrome',
      node: (
        <ErrorPanel
          title={args.drawable.title}
          detail={args.drawable.detail}
          {...(configureHref === null ? {} : { action: <ViewSettingsLink href={configureHref} /> })}
        />
      ),
    };
  }

  if (container.children.length === 0) {
    return {
      kind: 'chrome',
      node: (
        <EmptyPanel
          title={args.emptyTitle}
          detail={args.emptyDetail}
          // An empty state is exactly when somebody most needs the way out of it.
          {...(args.emptyAction === undefined ? {} : { action: args.emptyAction })}
        />
      ),
    };
  }

  if (saved.length === 0) {
    // The view's own settings hide everything. Clearing the address would change nothing, so the
    // way out is named rather than offered as a button that does not work.
    return {
      kind: 'chrome',
      node: (
        <EmptyPanel
          title="No items match this view's filters"
          detail={savedFiltersHideAll(
            container.children.length,
            args.subject,
            container.truncated,
            changeFilters !== null,
          )}
          action={
            changeFilters === null && args.emptyAction === undefined ? undefined : (
              <div className="flex flex-wrap items-center gap-3">
                {changeFilters}
                {args.emptyAction}
              </div>
            )
          }
        />
      ),
    };
  }

  if (addressed.length === 0) {
    // Emptiness we caused rather than emptiness we found, and told apart from it deliberately:
    // somebody who followed a filtered link and is told "nothing in here yet" goes looking for
    // items they think have been deleted.
    const message = args.filtered(saved.length);

    return {
      kind: 'chrome',
      node: (
        <EmptyPanel
          title={message.title}
          detail={message.detail}
          // The filters are in the address, which is not somewhere this screen can point at.
          action={
            <Button variant="secondary" onClick={viewState.clearFilters}>
              Clear filters
            </Button>
          }
        />
      ),
    };
  }

  if (visible.length === 0) {
    return {
      kind: 'chrome',
      node: (
        <EmptyPanel
          title="No loaded items match this title search"
          detail={`None of the ${String(addressed.length)} loaded items remaining after filters match. Clear the search above to see them.${container.truncated ? ' More items have not been loaded.' : ''}`}
        />
      ),
    };
  }

  const hiddenBySaved = container.children.length - saved.length;
  const hiddenByAddress = saved.length - addressed.length;
  const hiddenBySearch = addressed.length - visible.length;

  // Truncation is said alongside the filter notice, not instead of it: they are two different
  // partialities. A container past the paging ceiling shows its first pages, and every count a
  // view derives from `children` - a row count, a filtered total - is a claim about only those,
  // which this sentence is what keeps honest.
  const partiality = [
    container.truncated
      ? `Only the first ${String(container.children.length)} items in here are loaded.`
      : null,
    hiddenBySaved === 0 ? null : hiddenNotice(hiddenBySaved, "this view's saved filters"),
    hiddenByAddress === 0 ? null : hiddenNotice(hiddenByAddress, 'the current filters'),
    hiddenBySearch === 0 ? null : hiddenNotice(hiddenBySearch, 'the title search'),
    readerUnknown
      ? 'Rules about you could not be checked, so they are not applied and more items may show.'
      : null,
  ].filter((sentence): sentence is string => sentence !== null);

  const partialityNotice =
    partiality.length === 0 ? null : (
      <PartialNotice
        pending={partiality.join(' ')}
        {...(hiddenBySaved === 0 || changeFilters === null ? {} : { action: changeFilters })}
      />
    );
  const backgroundNotice = refreshNotice(
    container.refreshing,
    container.refreshError,
    args.subject,
  );

  return {
    kind: 'items',
    items: sorted,
    drawable: args.drawable.value,
    notice:
      partialityNotice === null && backgroundNotice === null ? null : (
        <>
          {partialityNotice}
          {backgroundNotice}
        </>
      ),
  };
}

/**
 * What a view says, alongside the items already on screen, about a reload running or failing in
 * the background.
 *
 * Rendered next to the data rather than instead of it - see {@link resolveLoadState}, which only
 * ever blanks the view for the load that has no data to protect yet. An error here is announced
 * (`role="alert"`) because it is a failure; a refresh in progress is merely informational
 * (`role="status"`), the same distinction {@link ErrorPanel} and {@link PartialNotice} draw.
 */
function refreshNotice(
  refreshing: boolean,
  refreshError: string | null,
  subject: string,
): ReactNode | null {
  if (refreshError !== null) {
    return (
      <div role="alert" className="flex items-start gap-2 border border-divider p-3">
        <Text variant="note" as="span" tone="accent">
          {refreshError} What is on screen is unaffected; try reloading {subject} again.
        </Text>
      </div>
    );
  }

  if (refreshing) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy={true}
        className="flex items-start gap-2 border border-divider p-3"
      >
        <Text variant="note" as="span" tone="muted">
          Refreshing {subject}
          {'…'}
        </Text>
      </div>
    );
  }

  return null;
}

/**
 * What a view says about the items its filters are holding back, and which filters those are.
 *
 * Worth saying out loud because nothing else on screen says it: a view drawing four of nine items
 * looks exactly like a container holding four. The two sources are named apart because they are
 * undone in different places - the address by clearing it, the view's own rules in its settings.
 */
function hiddenNotice(hidden: number, by: string): string {
  return hidden === 1
    ? `One more item is here and hidden by ${by}.`
    : `${String(hidden)} more items are here and hidden by ${by}.`;
}

function savedFiltersHideAll(
  total: number,
  subject: string,
  truncated: boolean,
  linked: boolean,
): string {
  // With the link beside it, the sentence telling somebody where to go would only repeat it.
  const where = linked ? '' : " Change them in the view's settings to see more.";

  // A truncated container's count is of what is loaded, not of what is there: "hide all 4,000"
  // would claim the items past the paging ceiling were checked too.
  if (truncated) {
    return `None of the first ${String(total)} loaded items match the filters saved with ${subject}.${where}`;
  }

  const items = total === 1 ? 'its one item' : `all ${String(total)} of its items`;
  return `The filters saved with ${subject} hide ${items}.${where}`;
}

/** "this board" as the first two words of a sentence. */
function capitalise(subject: string): string {
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}

/** The way from a view that cannot draw, or draws less than asked, to the settings that fix it. */
export function ViewSettingsLink({ href }: { readonly href: string }): ReactNode {
  return (
    <Link
      to={href}
      className={`inline-flex w-fit items-center underline pointer-coarse:min-h-(--control-lg) ${focusRing}`}
    >
      Change this view&apos;s settings
    </Link>
  );
}

/**
 * The part of the chrome's notices that is about the container rather than its filters: that only
 * the first pages of children are loaded, and that a background reload failed or is under way.
 * For a view that does not go through `useViewChrome` - the outline reads its own levels and
 * applies no filters - but must still not present a partial container as the whole of it.
 */
export function ContainerNotices({
  container,
  subject,
}: {
  readonly container: ContainerData;
  readonly subject: string;
}): ReactNode {
  const truncated = container.truncated ? (
    <PartialNotice
      pending={`Only the first ${String(container.children.length)} items at the top of ${subject} are loaded.`}
    />
  ) : null;
  const background = refreshNotice(container.refreshing, container.refreshError, subject);
  return truncated === null && background === null ? null : (
    <>
      {truncated}
      {background}
    </>
  );
}
