import { Button, Icon, Input, Popover, Segmented, Select, Text } from '@nix/ui';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { FilterRulesEditor } from '../query/filter-rules-editor';
import { TITLE_COLUMN_KEY } from './columns';
import { BelowRowSlot } from './view-switcher';
import type { PropertyDefinition, View, ViewFilterRule } from './container-model';
import type { SortDirection, ViewStateControl } from './view-state';

export type ViewToolsPlacement = 'row' | 'inline';

export interface ViewToolsProps {
  /** `row`: a fragment for the view switcher's flex-wrap row. `inline`: its own row above the contents. */
  readonly placement?: ViewToolsPlacement;
  readonly view: View | null;
  readonly schema: readonly PropertyDefinition[];
  readonly viewState: Pick<
    ViewStateControl,
    | 'search'
    | 'setSearch'
    | 'filters'
    | 'clearFilters'
    | 'sortBy'
    | 'direction'
    | 'setSort'
    | 'clearSort'
  >;
  readonly onSave: (filters: readonly ViewFilterRule[]) => Promise<string | null>;
}

const DIRECTIONS = [
  { value: 'ascending', label: 'Ascending' },
  { value: 'descending', label: 'Descending' },
] as const;

/**
 * Search, sort and saved filters as one compact row of icons. Sort and saved filters live in the
 * "View options" popover; on a phone the search field opens only when asked for, so the row costs
 * one line rather than the stack of label, field, hint and button it used to.
 */
export function ViewTools({
  placement = 'inline',
  view,
  schema,
  viewState,
  onSave,
}: ViewToolsProps): ReactNode {
  const narrow = useNarrowViewport();
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // The draft lives here, not in the popover, so dismissing the popover never loses an edit.
  const [draft, setDraft] = useState<readonly ViewFilterRule[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedCount = view?.filters.length ?? 0;
  const showSearch = !narrow || searchOpen || viewState.search.length > 0;

  function discard(): void {
    setDraft(null);
    setError(null);
  }

  async function save(close: () => void): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const refusal = await onSave(draft ?? view?.filters ?? []);
      if (refusal !== null) setError(refusal);
      else {
        discard();
        close();
      }
    } catch {
      setError('The filters could not be saved. Your changes are still here.');
    } finally {
      setSaving(false);
    }
  }

  const clearSearch = (
    <Button
      variant="icon"
      aria-label="Clear search"
      onClick={() => {
        viewState.setSearch('');
        searchInput.current?.focus();
      }}
    >
      <Icon icon={X} size="sm" />
    </Button>
  );
  const search = (
    <Input
      ref={searchInput}
      type="search"
      aria-label="Search titles"
      placeholder="Search titles"
      className={narrow ? 'min-w-0 flex-1' : 'w-48'}
      value={viewState.search}
      onChange={(event) => {
        viewState.setSearch(event.target.value);
      }}
    />
  );
  const hasSearch = viewState.search.length > 0;

  const clearLinkFilters =
    viewState.filters.length === 0 ? null : (
      <Button
        variant="ghost"
        onClick={() => {
          viewState.clearFilters();
          searchInput.current?.focus();
        }}
      >
        Clear link filters ({String(viewState.filters.length)})
      </Button>
    );
  const secondLine = narrow && (showSearch || clearLinkFilters !== null);
  const below = useContext(BelowRowSlot);
  const line = (
    <div
      className={`flex basis-full items-center gap-2 ${below === null ? 'order-last' : ''} ${placement === 'row' ? 'pb-1 pl-4 sm:pl-8' : ''}`}
    >
      {showSearch ? search : null}
      {showSearch && hasSearch ? clearSearch : null}
      {clearLinkFilters}
    </div>
  );

  const tools = (
    <>
      {narrow ? (
        <Button
          variant="icon"
          aria-label="Search titles"
          aria-expanded={showSearch}
          onClick={() => {
            // An empty field closes again; one holding text stays, so a search is never hidden.
            if (showSearch && !hasSearch) {
              setSearchOpen(false);
              return;
            }
            setSearchOpen(true);
            requestAnimationFrame(() => searchInput.current?.focus());
          }}
        >
          <Icon icon={Search} size="sm" />
        </Button>
      ) : (
        search
      )}
      {!narrow && hasSearch ? clearSearch : null}
      <Popover
        label="View options"
        trigger={(trigger) => (
          <Button
            {...trigger}
            variant="icon"
            aria-label={`View options${savedCount === 0 ? '' : `, ${String(savedCount)} saved filters`}`}
            className="w-auto gap-1 px-2"
          >
            <Icon icon={SlidersHorizontal} size="sm" />
            {savedCount === 0 ? null : (
              <Text as="span" variant="caption">
                {savedCount}
              </Text>
            )}
          </Button>
        )}
        className="w-80"
      >
        {({ close }) => (
          <div className="flex min-w-0 flex-col gap-3">
            <SortControls schema={schema} viewState={viewState} />
            {view === null ? null : (
              <section
                aria-label="Saved view filters"
                className="flex min-w-0 flex-col gap-3 border-t border-divider pt-3"
                aria-busy={saving}
              >
                <Text variant="note" tone="muted">
                  Saving changes this view&apos;s filters for everyone. Title search only changes
                  your current link.
                </Text>
                <fieldset disabled={saving} className="min-w-0">
                  <FilterRulesEditor
                    scope={view.kind === 'query' ? 'query' : 'container'}
                    rules={draft ?? view.filters}
                    schema={schema}
                    onChange={setDraft}
                  />
                </fieldset>
                {error === null ? null : (
                  <Text variant="note" tone="accent" role="alert">
                    {error}
                  </Text>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" disabled={saving} onClick={() => void save(close)}>
                    {saving ? 'Saving filters…' : 'Save view filters'}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      discard();
                      close();
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </section>
            )}
          </div>
        )}
      </Popover>
      {narrow ? null : clearLinkFilters}
      {secondLine ? (below === null ? line : createPortal(line, below)) : null}
    </>
  );

  return placement === 'row' ? (
    tools
  ) : (
    <div className="flex min-w-0 flex-wrap items-center gap-2 pb-3">{tools}</div>
  );
}

function SortControls({
  schema,
  viewState,
}: Pick<ViewToolsProps, 'schema' | 'viewState'>): ReactNode {
  const { sortBy, direction, setSort, clearSort } = viewState;
  return (
    <div role="group" aria-label="Sort" className="flex min-w-0 flex-col gap-2">
      <Select
        aria-label="Sort by"
        value={sortBy ?? ''}
        onChange={(event) => {
          const key = event.target.value;
          if (key === '') clearSort();
          else setSort(key, direction);
        }}
      >
        <option value="">View&apos;s order</option>
        <option value={TITLE_COLUMN_KEY}>Title</option>
        {schema.map((property) => (
          <option key={property.key} value={property.key}>
            {property.label}
          </option>
        ))}
      </Select>
      {sortBy === null ? null : (
        <Segmented<SortDirection>
          label="Direction"
          options={DIRECTIONS}
          value={direction}
          onChange={(next) => {
            setSort(sortBy, next);
          }}
        />
      )}
    </div>
  );
}
