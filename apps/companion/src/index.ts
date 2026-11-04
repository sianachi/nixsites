import { readConfig } from './config.ts';
import { stdoutLogger } from './diagnostics.ts';
import { createCompanionServer } from './server.ts';

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

const server = createCompanionServer(config, { logger });
server.listen(config.address.port, config.address.host, () => {
  logger.log('info', 'companion host listening', { port: config.address.port });
});

function shutdown(): void {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
