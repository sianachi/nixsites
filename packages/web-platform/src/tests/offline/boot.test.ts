import { describe, expect, it } from 'vitest';

import { canBootOffline } from '../../offline/boot';

const stored = { profile: { subject: 's', name: 'Ada', email: null } };

describe('offline boot decision', () => {
  it('opens on the synced copy when Core is unreachable and a profile is stored', () => {
    expect(canBootOffline('unreachable', stored)).toBe(true);
  });
  it('never does on a refusal, and never without a stored profile', () => {
    expect(canBootOffline('refused', stored)).toBe(false);
    expect(canBootOffline('unreachable', null)).toBe(false);
  });
});
