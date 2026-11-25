import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const connectionSchema = z.strictObject({
  epoch: z.uuid(),
  salt: z.uuid(),
  connected: z.boolean(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

const path = (home: string) => join(home, 'chatgpt-recipient.json');
function connection(home: string): z.infer<typeof connectionSchema> | undefined {
  try {
    const raw = readFileSync(path(home));
    if (raw.byteLength > 4096) return undefined;
    return connectionSchema.parse(JSON.parse(raw.toString('utf8')));
  } catch {
    return undefined;
  }
}

/** Pure metadata read. It never opens a provider process, token file, or network connection. */
export function recipientMetadata(
  home: string,
  provider: string,
): { provider: string; connectionRevision: string } {
  const saved = provider === 'chatgpt' ? connection(home) : undefined;
  return {
    provider,
    connectionRevision: saved?.connected === true ? saved.epoch : 'unknown',
  };
}

/** Account observations rotate an opaque epoch without persisting account fields. */
export function observeRecipientConnection(home: string, account: unknown): void {
  const saved = connection(home);
  const salt = saved?.salt ?? randomUUID();
  const connected = account !== null;
  const fingerprint = createHash('sha256')
    .update(salt)
    .update(JSON.stringify(account))
    .digest('hex');
  if (saved?.connected === connected && saved.fingerprint === fingerprint) return;
  const next = { salt, fingerprint, connected, epoch: randomUUID() };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = `${path(home)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  renameSync(temporary, path(home));
}
