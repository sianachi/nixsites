import { startSitesWorker } from './main.ts';

const worker = startSitesWorker();

function shutdown(): void {
  void worker.stop().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
