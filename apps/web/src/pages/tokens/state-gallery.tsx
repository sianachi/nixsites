import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { AsyncSection } from '@nix/web-foundation/components/states/async-section';
import type { AsyncStatus } from '@nix/web-foundation/lib/async-status';
import { empty, failed, loading, partial, ready } from '@nix/web-foundation/lib/async-status';
import { Blueprint, Card, Text, cn, focusRing } from '@nix/ui';

import {
  STATE_PREVIEWS,
  type StatePreview,
  statePreviewSearch,
  useStatePreview,
} from '../../routing/url-state';

/**
 * The state-pattern gallery, and the page's demonstration of the URL-state
 * convention.
 *
 * Which state is on screen is not React state - it is the `state` search
 * parameter. Refresh the page and the view is unchanged; copy the address and
 * a colleague lands on the state you were looking at. The switcher is built
 * from real links so it stays right-clickable and copyable, and the error
 * state's recovery affordance writes the same parameter programmatically,
 * which is the other half of the convention.
 *
 * The sample data is the canonical Nix truthfulness case: a file is
 * downloadable as soon as it is `clean` but searchable only once it is
 * `indexed`. The partial state has to say so, or a user concludes search is
 * broken.
 */

interface DemoItem {
  readonly id: string;
  readonly name: string;
  readonly pipelineStage: 'clean' | 'indexed';
}

const DEMO_ITEMS: readonly DemoItem[] = [
  { id: 'a', name: 'Acquisition memo', pipelineStage: 'indexed' },
  { id: 'b', name: 'Site survey photographs', pipelineStage: 'clean' },
  { id: 'c', name: 'Structural calculations', pipelineStage: 'clean' },
];

function buildStatus(preview: StatePreview, onRetry: () => void): AsyncStatus<readonly DemoItem[]> {
  switch (preview) {
    case 'loading':
      return loading('workspace items');
    case 'empty':
      return empty(
        'No items here yet',
        'This workspace is empty. Items added by anyone on the team will appear here.',
      );
    case 'error':
      return failed(
        'Could not load workspace items',
        'The request did not complete. Your items are safe; this view could not read them.',
        onRetry,
      );
    case 'partial':
      return partial(
        DEMO_ITEMS,
        'Two of these items are downloadable but not yet indexed, so search will not find them yet.',
      );
    case 'ready':
      return ready(DEMO_ITEMS);
    default: {
      const unreachable: never = preview;
      return failed('Unknown state', String(unreachable));
    }
  }
}

function ItemList({ items }: { readonly items: readonly DemoItem[] }): ReactElement {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <Blueprint as="li" key={item.id} className="flex items-baseline justify-between gap-4 p-4">
          <Text as="span">{item.name}</Text>
          <Text variant="kicker">
            {item.pipelineStage === 'indexed' ? 'Downloadable and searchable' : 'Downloadable only'}
          </Text>
        </Blueprint>
      ))}
    </ul>
  );
}

const SEGMENT_BASE =
  'block px-4 py-2 font-heading text-xs tracking-widest uppercase transition-colors ' + focusRing;

function PreviewSwitcher({ current }: { readonly current: StatePreview }): ReactElement {
  return (
    <nav aria-label="State pattern preview">
      <Blueprint>
        <ul className="flex flex-wrap divide-x divide-divider">
          {STATE_PREVIEWS.map((preview) => {
            const selected = preview === current;
            return (
              <li key={preview}>
                <Link
                  to={{ search: statePreviewSearch(preview) }}
                  replace
                  aria-current={selected ? 'true' : undefined}
                  className={cn(
                    SEGMENT_BASE,
                    selected
                      ? 'bg-accent-fill text-background'
                      : 'text-accent-text hover:bg-accent/10 active:bg-accent/18',
                  )}
                >
                  {preview}
                </Link>
              </li>
            );
          })}
        </ul>
      </Blueprint>
    </nav>
  );
}

export function StateGallery(): ReactElement {
  const { preview, setPreview } = useStatePreview();
  const status = buildStatus(preview, () => {
    setPreview('ready');
  });

  return (
    <Card kicker="Patterns" title="Loading, empty, error, partial">
      <Text tone="muted">
        Every data-bearing view in Nix renders all four of these honestly. The switcher writes the
        `state` search parameter, so the view survives a refresh and can be shared as a link.
      </Text>
      <PreviewSwitcher current={preview} />
      <AsyncSection status={status}>{(items) => <ItemList items={items} />}</AsyncSection>
    </Card>
  );
}
