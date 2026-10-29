import { useState } from 'react';

/** What the one polite announcer says: each finished reply once (its first 160 characters, never a
 * draft or a token), and a wait for approval. History already on screen when the chat opens is not
 * read, and neither is a reply that only became the last one because a newer one was removed
 * (Regenerate, an edited resend). Anything else that must
 * be spoken, such as the outcome of a build, goes through `outcome` rather than a second live region. */
export function useReplyAnnouncer({
  messages,
  petName,
  ready,
  approvalPending,
  outcome = '',
}: {
  readonly messages: readonly {
    readonly id: string;
    readonly role: string;
    readonly text: string;
  }[];
  readonly petName: string;
  readonly ready: boolean;
  readonly approvalPending: boolean;
  /** A short sentence to speak once when it changes, e.g. "Stopped after 2 of 5". */
  readonly outcome?: string;
}): string {
  const [state, setState] = useState<{
    known: readonly string[] | undefined;
    approval: boolean;
    outcome: string;
    flip: boolean;
    text: string;
  }>({ known: undefined, approval: false, outcome: '', flip: false, text: '' });
  const replies = messages.filter(
    (message) => message.role === 'assistant' && !message.id.includes(':draft:'),
  );
  const ids = replies.map((message) => message.id);
  const last = replies.at(-1);
  // A live region speaks only when its text changes, so a repeat of the same sentence alternates a
  // zero-width mark.
  const say = (flip: boolean, text: string) => ({ flip: !flip, text: text + (flip ? '​' : '') });
  // Adjusted during render, not in an effect: the announcement is derived from what just changed.
  if (ready && state.known?.join() !== ids.join()) {
    const known = state.known;
    const fresh = known !== undefined && last !== undefined && !known.includes(last.id);
    setState({
      ...state,
      known: ids,
      // What was already on screen when the chat opened is a baseline, not news.
      ...(known === undefined ? { outcome } : {}),
      ...(fresh ? say(state.flip, `${petName}: ${last.text.slice(0, 160)}`) : {}),
    });
  } else if (approvalPending !== state.approval) {
    setState({
      ...state,
      approval: approvalPending,
      // Cleared when the wait ends, so the next wait is a change and is spoken again.
      ...(approvalPending
        ? say(state.flip, `${petName} is waiting for your approval`)
        : { text: state.text.startsWith(`${petName} is waiting`) ? '' : state.text }),
    });
  } else if (outcome !== state.outcome) {
    setState({ ...state, outcome, ...(outcome ? say(state.flip, outcome) : {}) });
  }
  return state.text;
}
