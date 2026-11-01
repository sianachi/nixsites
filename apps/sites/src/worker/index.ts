import { createServer } from 'node:http';

import { ObjectTransfer } from '../shared/object-transfer.ts';
import { activateSite } from './activate.ts';
import { Broker, SITES_QUEUE, commandOf } from './broker.ts';
import { buildSite } from './build.ts';
import { readWorkerConfig } from './config.ts';
import { CoreClient } from './core-client.ts';
import { JobRunner, type DeliveryAction } from './dispatch.ts';
import { purgeSite } from './purge.ts';

/**
 * The sites worker: consumes `nix.worker.sites.v1`, runs build, activate and purge jobs, and
 * publishes their results. `/healthz` is liveness; `/readyz` proves the broker consumer is
 * attached and Core accepts this worker's credential.
 */

const config = readWorkerConfig(process.env);
const log = (message: string, fields?: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...fields })}\n`);
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
const broker = new Broker(config.rabbitmqUrl, log);

const runner = new JobRunner({
  core,
  publisher: broker,
  workerId: config.workerId,
  leaseSeconds: config.leaseSeconds,
  renewSeconds: config.renewSeconds,
  log,
  handlers: {
    'site.build': (context) =>
      buildSite({ core, objects, collab, internalSecret: config.internalSecret }, context),
    'site.activate': (context) => activateSite({ core, objects }, context),
    'site.purge': (context) => purgeSite({ core, objects }, context),
  },
});

const stopping = new AbortController();

const isStopping = (): boolean => stopping.signal.aborted;

async function slot(index: number): Promise<void> {
  while (!isStopping()) {
    try {
      await broker.consume(
        SITES_QUEUE,
        `${config.workerId}:${SITES_QUEUE}:${String(index)}`,
        async (envelope): Promise<DeliveryAction> => {
          const command = commandOf(envelope);
          return runner.handle(command, envelope.traceParent);
        },
        stopping.signal,
      );
    } catch (error) {
      log('broker consumer stopped', { slot: index, error: String(error) });
    }
    if (!isStopping()) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const health = createServer((request, response) => {
  void (async () => {
    if (request.url === '/healthz') {
      response.writeHead(200).end('ok');
    } else if (request.url === '/readyz') {
      const ready = broker.consumerReady() && (await core.ping(config.workerId));
      response.writeHead(ready ? 200 : 503).end(ready ? 'ready' : 'not ready');
    } else {
      response.writeHead(404).end();
    }
  })();
});
health.listen(config.address.port, config.address.host, () => {
  log('sites worker listening', { port: config.address.port, concurrency: config.concurrency });
});

for (let index = 0; index < config.concurrency; index += 1) void slot(index);

function shutdown(): void {
  stopping.abort();
  health.close();
  void broker.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
