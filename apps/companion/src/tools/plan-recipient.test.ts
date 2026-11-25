import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../testing/testing.ts';
import { observeRecipientConnection, recipientMetadata } from './plan-recipient.ts';

describe('opaque recipient connection epochs', () => {
  it('keeps a stable epoch for the same account and rotates for account change and disconnect', () => {
    const home = tempDir();
    expect(recipientMetadata(home, 'chatgpt').connectionRevision).toBe('unknown');
    observeRecipientConnection(home, { type: 'chatgpt', email: 'first@example.invalid' });
    const first = recipientMetadata(home, 'chatgpt');
    expect(first.connectionRevision).not.toBe('unknown');
    observeRecipientConnection(home, { type: 'chatgpt', email: 'first@example.invalid' });
    expect(recipientMetadata(home, 'chatgpt')).toEqual(first);
    observeRecipientConnection(home, { type: 'chatgpt', email: 'second@example.invalid' });
    expect(recipientMetadata(home, 'chatgpt').connectionRevision).not.toBe(
      first.connectionRevision,
    );
    observeRecipientConnection(home, null);
    expect(recipientMetadata(home, 'chatgpt').connectionRevision).toBe('unknown');
    const stored = readFileSync(join(home, 'chatgpt-recipient.json'), 'utf8');
    expect(stored).not.toContain('example.invalid');
    expect(Object.keys(recipientMetadata(home, 'chatgpt')).sort()).toEqual([
      'connectionRevision',
      'provider',
    ]);
  });

  it('cannot use keyed-provider metadata as a key hint or inferred recipient identity', () => {
    const home = tempDir();
    expect(recipientMetadata(home, 'openai')).toEqual({
      provider: 'openai',
      connectionRevision: 'unknown',
    });
  });
});
