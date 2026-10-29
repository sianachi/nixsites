import type { ReactNode } from 'react';

import { SuggestionAction, SuggestionHint } from './suggestion-hint';

/**
 * "A similar item already exists", said once, with a way to go and look.
 *
 * Informational only: it never blocks the create, and pressing Enter in the field still makes the
 * new item. Somebody keeping two "Weekly review" items on purpose should lose nothing but the
 * second it takes to read one line. `where` says whether the match is a sibling or lives elsewhere
 * in the workspace, because "already exists" with no place attached sends people looking in the
 * wrong list.
 *
 * **Opening it leaves this view.** Every view's `onOpen` replaces the pane's item (see
 * `tabs/use-open-item.ts`), which unmounts the create field and the title typed into it. The button
 * says so rather than quietly throwing the draft away; somebody who wants to keep typing simply
 * does not press it.
 */

export interface DuplicateNoticeProps {
  readonly title: string;
  readonly where: 'here' | 'workspace';
  readonly onOpen: () => void;
}

export function DuplicateNotice(props: DuplicateNoticeProps): ReactNode {
  const { title, where, onOpen } = props;
  const name = title.length > 0 ? title : 'Untitled';

  return (
    <SuggestionHint
      actions={
        <SuggestionAction label={`Open ${name} (discards this draft)`} onClick={onOpen}>
          Open, discarding this draft
        </SuggestionAction>
      }
    >
      A similar item already exists {where === 'here' ? 'here' : 'elsewhere in this workspace'}:{' '}
      <span className="font-semibold">{name}</span>
    </SuggestionHint>
  );
}
