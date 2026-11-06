import { describe, expect, it } from 'vitest';
import { agentGate, batchRecords, lookupItems, upsertRecord } from './agent-records.js';
import { OPERATIONS } from '../operations.js';

describe('agentGate', () => {
  it('gates approve, revoke and public link creation only', () => {
    expect(agentGate('SetFileVersionState', { state: 'approved' })).toBe('approve');
    expect(agentGate('SetFileVersionState', { state: 'revoked' })).toBe('approve');
    expect(agentGate('SetFileVersionState', { state: 'in_review' })).toBeUndefined();
    expect(agentGate('SetFileVersionState', { state: 'draft' })).toBeUndefined();
    expect(agentGate('SetFileVersionState', undefined)).toBeUndefined();
    expect(agentGate('CreatePublicLink', {})).toBe('public-link');
    expect(agentGate('RevokePublicLink', undefined)).toBeUndefined();
  });

  it('names operations that exist in the generated catalog', () => {
    const ids = new Set(OPERATIONS.map((entry) => entry.id));
    for (const id of ['SetFileVersionState', 'CreatePublicLink']) expect(ids.has(id)).toBe(true);
  });
});

describe('record endpoints', () => {
  it('build the contract paths and strict-by-default bodies', () => {
    const upsert = upsertRecord('p1', { keyField: 'url', keyValue: 'https://example.com' });
    expect(upsert.path).toBe('/api/v1/items/p1/records/upsert');
    expect(upsert.body).toMatchObject({ strict: true, idempotencyKey: null });
    expect(batchRecords('w1', []).body).toEqual({ rows: [], strict: true });
    const lookup = lookupItems('w1', { key: 'url', value: 'x' });
    expect(lookup).toMatchObject({ method: 'POST', path: '/api/v1/workspaces/w1/lookup' });
  });
});
