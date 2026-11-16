/**
 * Recognises `nixctl mcp --listen ...`, the long-running HTTP service every install runs, from the
 * raw arguments, so the entry point can start it without loading the rest of the CLI (which costs
 * about 30 MiB the service never uses). Anything else it does not recognise exactly - a global
 * flag, `--help`, stdio mode, a missing API address - returns null and takes the ordinary path,
 * which parses and reports as before.
 */

export interface McpServeRequest {
  readonly listen: string;
  readonly apiUrl: string;
  readonly collabUrl: string | undefined;
  readonly publicOrigin: string | undefined;
}

const FLAGS = new Set(['--listen', '--api-url', '--collab-url', '--public-url']);

export function mcpServeRequest(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): McpServeRequest | null {
  if (args[0] !== 'mcp') return null;
  const given = new Map<string, string>();
  for (let index = 1; index < args.length; index += 1) {
    const [flag = '', inline] = (args[index] ?? '').split(/=(.*)/s, 2);
    const value = inline ?? args[(index += 1)];
    if (!FLAGS.has(flag) || value === undefined || given.has(flag)) return null;
    given.set(flag, value);
  }
  const listen = given.get('--listen') ?? env.NIX_MCP_LISTEN;
  const apiUrl = given.get('--api-url') ?? env.NIX_API_URL;
  if (listen === undefined || apiUrl === undefined) return null;
  const publicUrl = given.get('--public-url') ?? env.NIX_MCP_PUBLIC_URL;
  let publicOrigin: string | undefined;
  try {
    publicOrigin = publicUrl ? new URL(publicUrl).origin : undefined;
  } catch {
    return null;
  }
  return {
    listen,
    apiUrl,
    collabUrl: given.get('--collab-url') ?? env.NIX_COLLAB_URL,
    publicOrigin,
  };
}
