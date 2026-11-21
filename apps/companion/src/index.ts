import { readConfig } from './core/config.ts';
import { stdoutLogger } from './shared/diagnostics.ts';
import { startCompanion } from './server/lifecycle.ts';

/**
 * The pet companion service: `POST /v1/companion` for Core's PetWorkerClient, `/healthz` for
 * liveness, `/readyz` for a writable data directory and a Core that accepts the credential.
 */

const logger = stdoutLogger();
let config;
try {
  config = readConfig(process.env);
} catch (error) {
  logger.log('error', 'invalid configuration', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

let running: Awaited<ReturnType<typeof startCompanion>>;
try {
  running = await startCompanion(config, logger);
} catch (error) {
  logger.log('error', 'companion failed to start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

function shutdown(): void {
  void running.stop().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
