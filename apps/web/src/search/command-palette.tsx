import { useDrawerNavigation } from '@nix/web-foundation/layout/viewport';
import { Dialog, Icon, Input, Listbox, Text, useListbox, type ListboxOption } from '@nix/ui';
import { search, type SearchHit } from '@nix/api-client';
import { FileText, Search } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useHiddenItemPredicate } from '../collections/items/use-hidden-items';
import { filterCommands, type PaletteCommand } from './commands';

/**
 * Search, jump and run a command, from anywhere.
 *
 * It opens over whatever is on screen and closes back onto it, because searching is something you
 * do *while* reading a document rather than instead of reading one. Sending somebody to a search
 * page loses their place and makes returning a navigation problem they did not ask to have.
 *
 * **What replaced what.** The surface, the shortcut and the muscle memory are the ones the search
 * overlay established; what changed is underneath. It used to filter the titles the workspace tree
 * had already loaded, and the panel said so - which was honest but not useful, because the tree
 * fetches children per folder on expansion and the item somebody is looking for is nearly always
 * in a folder they have not opened. It now asks the server, which searches titles and document
 * text across every workspace the caller may read, filtered inside the query.
 *
 * **Commands and items in one list, not two.** They are ordered - commands first, then items -
 * rather than separated into panes, so one sequence of arrow keys walks the whole answer and Enter
 * always commits whatever is highlighted.
 */

/** One completed search, tagged with the query it answers, so a stale one is never shown. */
interface SearchAnswer {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly truncated: boolean;
  readonly failed: boolean;
}

const EMPTY_HITS: readonly SearchHit[] = [];

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 150;

/** The most items to offer. A palette is scanned, not read. */
const RESULT_LIMIT = 20;

/**
 * The shortest query sent to the server, matching `SearchItemsHandler.MinimumQueryLength`.
 *
 * Below three characters there is no trigram to look up, so the server would read every item in
 * every workspace the caller can reach and filter it - measured at nearly four times the cost of a
 * real query, growing with the workspace rather than with the number of matches. Commands are still
 * filtered locally at any length, because that list is five entries in memory.
 */
const MINIMUM_QUERY = 3;

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly preserveQuery?: boolean;
  readonly commands: readonly PaletteCommand[];
  readonly onSelectItem: (itemId: string) => void;
  readonly onClose: () => void;
}

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const { open, commands, onSelectItem, onClose, preserveQuery = false } = props;
  const client = useApiClient();
  const isHidden = useHiddenItemPredicate();
  const narrow = useDrawerNavigation();
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const instructionsId = useId();

  // Reset on the way out rather than in an effect on the way in: a setState inside an effect body
  // cascades a second render for something the close already knew, and reopening has to start
  // fresh rather than showing the last search's results as though they were current.
  const close = useCallback((): void => {
    if (!preserveQuery) {
      setQuery('');
      setAnswer(null);
    }
    onClose();
  }, [onClose, preserveQuery]);

  const commandOnly = query.trimStart().startsWith('>');
  const needle = (commandOnly ? query.trimStart().slice(1) : query).trim();

  useEffect(() => {
    if (!open || commandOnly || needle.length < MINIMUM_QUERY) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const parsed = await client.query(search.searchItems(needle, RESULT_LIMIT), {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setAnswer({
            query: needle,
            hits: parsed.results,
            truncated: parsed.truncated,
            failed: false,
          });
        } catch (cause) {
          if (controller.signal.aborted) {
            return;
          }

          // Reported as a failure rather than as "nothing matches". A palette that says a
          // workspace is empty when the request failed sends somebody off to recreate a document
          // they already have.
          console.warn('The search failed.', cause);
          setAnswer({ query: needle, hits: EMPTY_HITS, truncated: false, failed: true });
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, needle, open, commandOnly]);

  const current = !commandOnly && answer !== null && answer.query === needle ? answer : null;
  const allHits = current?.hits ?? EMPTY_HITS;
  const hits = allHits.filter((hit) => !isHidden(hit.id, hit.workspaceId));
  const matched = filterCommands(commands, needle);

  // In flight, and said out loud regardless of how many options happen to be showing. Carried by
  // `emptyMessage` alone, this was invisible whenever a command matched: type "n", the item results
  // for the previous query vanish because they answer a different needle, and nothing explains why.
  const searching = !commandOnly && needle.length >= MINIMUM_QUERY && current === null;

  // Commands first, then items, in one list. The index into it is what the keyboard walks, so the
  // two kinds are told apart on the way out rather than on the way in.
  const options: readonly ListboxOption[] = [
    ...matched.map((command) => ({
      id: `command:${command.id}`,
      label: command.label,
      hint: narrow
        ? command.shortcut
        : [command.hint, command.shortcut]
            .filter((part): part is string => part !== undefined && part !== '')
            .join(' · '),
      icon: command.icon,
      group: 'Commands',
    })),
    ...hits.map((hit) => ({
      id: `item:${hit.id}`,
      label: hit.title ?? 'Untitled',
      icon: FileText,
      group: 'Items',
    })),
  ];

  const listbox = useListbox(options, (_option, index) => {
    if (index < matched.length) {
      matched[index]?.run();
      close();
      return;
    }

    const hit = hits[index - matched.length];
    if (hit !== undefined) {
      onSelectItem(hit.id);
      close();
    }
  });

  if (!open) {
    return null;
  }

  const panel = (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div
        className={[
          'flex min-w-0 items-center gap-3 px-3 sm:px-5',
          options.length === 0 ? '' : 'border-b border-divider',
        ].join(' ')}
      >
        <Icon icon={Search} size="md" />

        <Input
          ref={inputRef}
          tone="plain"
          role="combobox"
          aria-expanded={listbox.expanded}
          aria-autocomplete="list"
          autoComplete="off"
          aria-controls={listbox.id}
          aria-activedescendant={listbox.activeOptionId}
          aria-label="Search items or run a command"
          aria-describedby={instructionsId}
          placeholder="Search or run a command"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            listbox.onKeyDown(event);
          }}
          className="h-[var(--control-lg)] text-lg"
        />
      </div>

      <Listbox
        label="Commands and items"
        options={options}
        controller={listbox}
        emptyMessage={
          current?.failed === true
            ? 'The search could not be run just now. Check your connection and try again.'
            : commandOnly
              ? `No commands match “${needle}”.`
              : needle.length === 0
                ? 'Type to search items, or start with > for commands only.'
                : needle.length < MINIMUM_QUERY
                  ? `Type ${String(MINIMUM_QUERY)} letters or more to search items.`
                  : searching
                    ? 'Searching…'
                    : allHits.length > 0
                      ? 'Matching items are hidden. Manage them in Workspace options.'
                      : `Nothing matches “${needle}”.`
        }
        className="min-h-0 max-h-[calc(100dvh-7rem)] overflow-y-auto"
      />

      {/*
          One line under the list, carrying whichever of these applies. `role="status"` because all
          three arrive without the person doing anything, and the mounted-empty region is what makes
          the announcement reliable.
        */}
      <div role="status" className="empty:hidden">
        {hits.length < allHits.length ? (
          <Text variant="caption" tone="muted" className="px-4 py-2">
            {String(allHits.length - hits.length)} hidden
          </Text>
        ) : null}
        {searching ? (
          <Text as="p" variant="caption" tone="muted" className="border-t border-divider px-4 py-2">
            Searching…
          </Text>
        ) : current?.truncated === true ? (
          <Text as="p" variant="caption" tone="muted" className="border-t border-divider px-4 py-2">
            Only the first {allHits.length} matching items were loaded. Type more to narrow it down.
          </Text>
        ) : current !== null && allHits.length === 0 && matched.length > 0 ? (
          // The palette found a command but no document, and the reason may be timing rather than
          // absence: text inside documents becomes searchable when the document is saved. Said
          // here for the same reason the backlinks panel says it.
          <Text as="p" variant="caption" tone="muted" className="border-t border-divider px-4 py-2">
            No items matched. Text inside a document becomes searchable once it has been saved.
          </Text>
        ) : null}
      </div>
      <Text
        id={instructionsId}
        as="p"
        variant="caption"
        tone="muted"
        className="shrink-0 border-t border-divider px-3 py-2"
      >
        {commandOnly ? 'Commands only. Remove > to search items.' : 'Type > for commands only.'}
        <span className="hidden sm:inline">
          {' '}
          Arrow keys to choose · Enter to open · Esc to close
        </span>
      </Text>
    </div>
  );
  return (
    <Dialog
      open
      title="Search and commands"
      closeLabel="Close search"
      onClose={close}
      initialFocus={inputRef}
      presentation={narrow ? 'workspace' : 'standard'}
    >
      {panel}
    </Dialog>
  );
}
