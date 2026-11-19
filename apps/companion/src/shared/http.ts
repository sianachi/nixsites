import type { IncomingMessage } from 'node:http';

export async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) return;
    size += chunk.length;
    if (size > limit) return;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
