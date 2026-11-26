import { describe, expect, it } from 'vitest';

import { notificationsPageResponseSchema } from './notifications.js';

const row = {
  id: '0b0b0b0b-1111-4111-8111-0b0b0b0b0b0b',
  kind: 'message',
  title: 't',
  body: 'b',
  itemId: null,
  workspaceId: null,
  createdAt: '2026-11-26T01:00:00Z',
  readAt: null,
};
const page = (kind: string) => ({
  items: [{ ...row, kind }],
  nextCursor: null,
  unread: 1,
  revision: 1,
});

describe('notification kinds', () => {
  it('keeps a known kind and reads one it does not know as a system notice', () => {
    expect(notificationsPageResponseSchema.parse(page('message')).items[0]?.kind).toBe('message');
    expect(notificationsPageResponseSchema.parse(page('from-the-future')).items[0]?.kind).toBe(
      'system',
    );
  });
});
