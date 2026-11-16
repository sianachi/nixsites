#!/usr/bin/env -S node --experimental-strip-types
/**
 * What `nixctl` runs. The HTTP MCP service starts on its own; every other invocation loads the
 * CLI in `index.ts`. Kept apart from it so nothing here imports a command.
 */
import { mcpServeRequest } from './mcp-serve-args.ts';

const serve = mcpServeRequest(process.argv.slice(2), process.env);
if (serve !== null) {
  const { startMcpHttpServer } = await import('./mcp-http.ts');
  await startMcpHttpServer(serve);
} else {
  const [{ buildProgram }, { printError }] = await Promise.all([
    import('./index.ts'),
    import('./output.ts'),
  ]);
  await buildProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      process.exitCode = printError(error);
    });
}
