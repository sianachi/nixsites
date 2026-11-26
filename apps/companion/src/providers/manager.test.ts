import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { boot, IDS, tempDir, type Booted } from '../testing/testing.ts';
import { removeChatGptCredentials } from './manager.ts';

const open: Booted[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

describe('the retired ChatGPT link', () => {
  it("deletes each home's saved sign-in and recipient record, and nothing else", () => {
    const dataDir = tempDir();
    const home = join(dataDir, `${IDS.tenant}-${IDS.principal}`);
    mkdirSync(home, { recursive: true });
    for (const name of ['auth.json', 'chatgpt-recipient.json', 'conversation.json'])
      writeFileSync(join(home, name), '{}');
    writeFileSync(join(dataDir, 'stray.txt'), 'x');

    removeChatGptCredentials(dataDir);

    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    expect(existsSync(join(home, 'chatgpt-recipient.json'))).toBe(false);
    expect(existsSync(join(home, 'conversation.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'stray.txt'))).toBe(true);
  });

  it.each(['', 'chatgpt', 'openai'])(
    'answers 503 for a request whose provider is %j, without starting one',
    async (provider) => {
      let launches = 0;
      const app = await boot({
        launch: () => {
          launches += 1;
          throw new Error('no provider may start');
        },
      });
      open.push(app);
      const response = await app.call({
        operation: 'status',
        provider,
        workspaceId: '',
        petId: '',
      });
      expect(response.status).toBe(503);
      expect(launches).toBe(0);
    },
  );
});
