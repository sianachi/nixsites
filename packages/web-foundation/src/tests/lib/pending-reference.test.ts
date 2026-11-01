import { afterEach, expect, it, vi } from 'vitest';
import {
  clearPendingReference,
  offerReference,
  onPendingReferenceChanged,
  pendingReference,
} from '../../lib/pending-reference';

const first = { sourceId: 'a', targetId: 'b', label: 'B' };
const second = { sourceId: 'c', targetId: 'd', label: 'D' };

afterEach(() => {
  clearPendingReference();
});

it('holds an offered reference and notifies a subscriber once', () => {
  const listener = vi.fn();
  onPendingReferenceChanged(listener);
  offerReference(first);
  expect(pendingReference()).toBe(first);
  expect(listener).toHaveBeenCalledTimes(1);
});

it('replaces the first offer with a second', () => {
  offerReference(first);
  offerReference(second);
  expect(pendingReference()).toBe(second);
});

it('does not notify when clearing with nothing pending', () => {
  const listener = vi.fn();
  onPendingReferenceChanged(listener);
  clearPendingReference();
  expect(listener).not.toHaveBeenCalled();
});

it('does not call an unsubscribed listener', () => {
  const listener = vi.fn();
  onPendingReferenceChanged(listener)();
  offerReference(first);
  expect(listener).not.toHaveBeenCalled();
});
