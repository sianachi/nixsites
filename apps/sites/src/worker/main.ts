import { createServer } from 'node:http';

import { ObjectTransfer } from '../shared/object-transfer.ts';
import { activateSite } from './activate.ts';
import { buildSite } from './build.ts';
import { readWorkerConfig } from './config.ts';
import { CoreClient } from './core-client.ts';
import { JobRunner, type JobHandler } from './dispatch.ts';
import { Poller } from './poller.ts';
import { purgeSite } from './purge.ts';

/**
 * The sites worker: leases `site.build`, `site.activate` and `site.purge` jobs from Core and
 * completes them there. `/healthz` is liveness; `/readyz` proves Core accepts this worker's
 * credential.
 */

export function startSitesWorker(): { stop: () => Promise<void> } {
  const config = readWorkerConfig(process.env);
  const log = (message: string, fields?: Record<string, unknown>): void => {
    process.stdout.write(
      `${JSON.stringify({ at: new Date().toISOString(), message, ...fields })}\n`,
    );
  };

  const core = new CoreClient({
    baseUrl: config.apiUrl,
    secret: config.internalSecret,
    release: {
      version: process.env.NIX_RELEASE_VERSION ?? '',
      commit: process.env.NIX_RELEASE_COMMIT ?? '',
    },
  });
  const objects = new ObjectTransfer({ origins: config.objectOrigins });
  const collab = new ObjectTransfer({ origins: [config.collabUrl] });

  const handlers: Readonly<Record<string, JobHandler>> = {
    'site.build': (context) =>
      buildSite({ core, objects, collab, internalSecret: config.internalSecret }, context),
    'site.activate': (context) => activateSite({ core, objects }, context),
    'site.purge': (context) => purgeSite({ core, objects }, context),
  };

  const runner = new JobRunner({
    core,
    leaseSeconds: config.leaseSeconds,
    renewSeconds: config.renewSeconds,
    log,
    handlers,
  });
  const poller = new Poller({
    core,
    runner,
    kinds: Object.keys(handlers),
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    pollSeconds: config.pollSeconds,
    concurrency: config.concurrency,
    log,
  });

  const stopping = new AbortController();

  const health = createServer((request, response) => {
    void (async () => {
      if (request.url === '/healthz') {
        response.writeHead(200).end('ok');
      } else if (request.url === '/readyz') {
        const ready = await core.ping(config.workerId);
        response.writeHead(ready ? 200 : 503).end(ready ? 'ready' : 'not ready');
      } else {
        response.writeHead(404).end();
      }
    })();
  });
  health.listen(config.address.port, config.address.host, () => {
    log('sites worker listening', { port: config.address.port, concurrency: config.concurrency });
  });

  const running = poller.run(stopping.signal);

  return {
    stop: async () => {
      stopping.abort();
      health.close();
      await running;
    },
  };
}
