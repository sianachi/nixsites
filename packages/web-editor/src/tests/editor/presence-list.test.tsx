import { act, render, screen } from '@testing-library/react';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import { PresenceList } from '../../editor/presence-list';

/**
 * The roster's honesty: who is here now, read from awareness, with the viewer themself
 * excluded - a presence list that counts you is padding its numbers.
 */

const docs: Y.Doc[] = [];
const instances: awarenessProtocol.Awareness[] = [];

function makeAwareness(): awarenessProtocol.Awareness {
  const doc = new Y.Doc();
  docs.push(doc);
  const awareness = new awarenessProtocol.Awareness(doc);
  instances.push(awareness);
  return awareness;
}

/** Introduces a peer to `host` the way the wire does: an encoded awareness update. */
function joinPeer(host: awarenessProtocol.Awareness, name: string): awarenessProtocol.Awareness {
  const peer = makeAwareness();
  peer.setLocalStateField('user', { name, color: 'var(--color-accent-600)' });
  awarenessProtocol.applyAwarenessUpdate(
    host,
    awarenessProtocol.encodeAwarenessUpdate(peer, [peer.clientID]),
    'test',
  );
  return peer;
}

afterEach(() => {
  for (const awareness of instances.splice(0)) {
    awareness.destroy();
  }
  for (const doc of docs.splice(0)) {
    doc.destroy();
  }
});

describe('the presence list', () => {
  it('renders nothing when nobody else is here', () => {
    const awareness = makeAwareness();
    awareness.setLocalStateField('user', { name: 'Me', color: 'var(--color-accent-600)' });

    const { container } = render(<PresenceList awareness={awareness} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows each peer as a quiet initials profile with their name, and announces the count politely', () => {
    const awareness = makeAwareness();
    awareness.setLocalStateField('user', { name: 'Me Myself', color: 'var(--color-accent-600)' });
    joinPeer(awareness, 'Ada Lovelace');
    joinPeer(awareness, 'Grace Hopper');

    render(<PresenceList awareness={awareness} />);

    const roster = screen.getByLabelText('2 people here');
    expect(roster).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByLabelText('Ada Lovelace')).toHaveAttribute('title', 'Ada Lovelace');
    // The cursor colour is only the outline; the profile itself stays on the surface.
    expect(screen.getByLabelText('Grace Hopper').style.borderColor).toBe('var(--color-accent-600)');
    expect(screen.getByLabelText('Grace Hopper')).toHaveTextContent('GH');
    // The viewer is not in their own roster.
    expect(screen.queryByLabelText('Me Myself')).toBeNull();
  });

  it('collapses a crowd into a count instead of a wall of faces', () => {
    const awareness = makeAwareness();
    for (const name of ['One A', 'Two B', 'Three C', 'Four D', 'Five E', 'Six F']) {
      joinPeer(awareness, name);
    }

    render(<PresenceList awareness={awareness} />);

    expect(screen.getByLabelText('6 people here')).toHaveTextContent('+2');
  });

  it('updates when a peer leaves', () => {
    const awareness = makeAwareness();
    const ada = joinPeer(awareness, 'Ada Lovelace');

    render(<PresenceList awareness={awareness} />);
    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument();

    act(() => {
      awarenessProtocol.removeAwarenessStates(awareness, [ada.clientID], 'test');
    });

    expect(screen.queryByLabelText('Ada Lovelace')).toBeNull();
  });
});
