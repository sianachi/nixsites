import { SqlStores } from './sql-store.mjs';

// Entry of the utility process that owns the databases (see sql-client.mjs).

const { parentPort } = process;
const stores = new SqlStores({ baseDir: process.argv[2] });

parentPort.on('message', ({ data: { id, origin, request } }) => {
  stores.handle(origin, request).then(
    (value) => {
      parentPort.postMessage({ id, value });
    },
    (error) => {
      parentPort.postMessage({ id, error: error?.message ?? 'Failed.' });
    },
  );
});

// The client kills this process when these stop: a query that never returns stops the timer too.
setInterval(() => {
  parentPort.postMessage({ beat: true });
}, Number(process.argv[3]));
parentPort.postMessage({ beat: true });
