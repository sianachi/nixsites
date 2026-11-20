import { createServer } from 'node:http';

import {
  READINESS_PATHS,
  rolesReady,
  startRoles,
  stopAll,
  type Running,
  type Starters,
} from './lifecycle.ts';
import { parseRoles, type Role } from './roles.ts';

/**
 * One process for the Node services. Each role keeps its own port and environment, so a role
 * behaves the same here as it did in its own container. A role that cannot start takes the
 * whole process down after the roles already started have been stopped. `/healthz` on the
 * host port is liveness; `/readyz` is ready only when every configured role is.
 */

const starters: Starters = {
  collab: async () => (await import('../../collab/src/main.ts')).startCollab(),
  'sites-worker': async () => (await import('../../sites/src/worker/main.ts')).startSitesWorker(),
  companion: async () => {
    const { readConfig } = await import('../../companion/src/core/config.ts');
    const { stdoutLogger } = await import('../../companion/src/shared/diagnostics.ts');
    const { startCompanion } = await import('../../companion/src/server/lifecycle.ts');
    return startCompanion(readConfig(process.env), stdoutLogger());
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

let running: Running[];
try {
  running = await startRoles(roles, starters);
} catch (cause) {
  fail('A role failed to start.', cause);
}

const probeRole = async (role: Role): Promise<boolean> => {
  const { port, path } = READINESS_PATHS[role];
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(3000),
  });
  return response.ok;
};
const host = createServer((request, response) => {
  void (async () => {
    if (request.url === '/healthz') {
      response.writeHead(200).end('ok');
    } else if (request.url === '/readyz') {
      const ready = await rolesReady(roles, probeRole);
      response.writeHead(ready ? 200 : 503).end(ready ? 'ready' : 'not ready');
    } else {
      response.writeHead(404).end();
    }
  })();
});
const hostPort = Number(process.env.NIX_NODE_HOST_PORT ?? 8099);
host.listen(hostPort, () => {
  process.stdout.write(`nix node host running: ${roles.join(', ')} (probes on ${hostPort})\n`);
});

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  host.close();
  void stopAll(running).then((failures) => {
    if (failures.length === 0) process.exit(0);
    fail('Shutdown did not complete cleanly.', failures[0]);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
