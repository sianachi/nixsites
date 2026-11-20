import type { CompanionConfig } from '../core/config.ts';
import type { stdoutLogger } from '../shared/diagnostics.ts';
import { createCompanionServer } from './server.ts';

/** Starts the companion HTTP server; resolves once it listens and rejects if it cannot bind. */
export async function startCompanion(
  config: CompanionConfig,
  logger: ReturnType<typeof stdoutLogger>,
): Promise<{ stop: () => Promise<void> }> {
  const server = createCompanionServer(config, { logger });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.address.port, config.address.host, () => {
      logger.log('info', 'companion listening', { port: config.address.port });
      resolve();
    });
  });
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
