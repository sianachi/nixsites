import { parseRoles, type Role } from './roles.ts';

/**
 * One process for the Node services. Each role keeps its own port and environment, so a role
 * behaves the same here as it did in its own container. A role that cannot start takes the
 * whole process down: a half-running host would pass its healthcheck for the roles that did.
 */

interface Running {
  stop: () => Promise<void>;
}

const starters: Record<Role, () => Promise<Running>> = {
  collab: async () => (await import('../../collab/src/main.ts')).startCollab(),
  'sites-worker': async () => (await import('../../sites/src/worker/main.ts')).startSitesWorker(),
  companion: async () => {
    const { readConfig } = await import('../../companion/src/core/config.ts');
    const { stdoutLogger } = await import('../../companion/src/shared/diagnostics.ts');
    const { createCompanionServer } = await import('../../companion/src/server/server.ts');
    const config = readConfig(process.env);
    const logger = stdoutLogger();
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
  },
};

function fail(message: string, cause: unknown): never {
  console.error(message, cause instanceof Error ? cause.message : cause);
  process.exit(1);
}

let roles: Role[];
try {
  roles = parseRoles(process.env.NIX_NODE_ROLES);
} catch (cause) {
  fail('Invalid NIX_NODE_ROLES.', cause);
}

const running: Running[] = [];
try {
  for (const role of roles) running.push(await starters[role]());
} catch (cause) {
  fail('A role failed to start.', cause);
}
process.stdout.write(`nix node host running: ${roles.join(', ')}\n`);

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  void Promise.all(running.map((role) => role.stop())).then(
    () => process.exit(0),
    (cause: unknown) => fail('Shutdown did not complete cleanly.', cause),
  );
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
