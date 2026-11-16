import { describe, expect, it } from 'vitest';

import { requestBytes } from './engine.js';

describe('requestBytes', () => {
  it('is the serialized request plus the allowance for non-ASCII client IDs, for any batch', () => {
    const document = (itemId: string, clientIds: string[]) => ({
      itemId,
      stateVector: 'AA==',
      expectedDocId: '00000000-0000-4000-8000-000000000001',
      updates: clientIds.map((clientId) => ({ clientId, update: 'AQID' })),
    });
    const batches = [
      [],
      [document('a', [])],
      [document('a', ['é-client', '客户']), document('b', ['x']), document('c', [])],
    ];
    for (const documents of batches) {
      const updates = documents.reduce((sum, entry) => sum + entry.updates.length, 0);
      expect(requestBytes({ documents })).toBe(
        JSON.stringify({ documents }).length + updates * 400,
      );
    }
  });
});
