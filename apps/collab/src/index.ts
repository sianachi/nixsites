import { startCollab } from './main.ts';

const collab = await startCollab();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    collab.stop().then(
      () => process.exit(0),
      (cause: unknown) => {
        // Still exit, and say so: a shutdown that fails half-way must not leave a process that
        // no longer serves anything and never ends.
        console.error('Shutdown did not complete cleanly.', cause);
        process.exit(1);
      },
    );
  });
}
