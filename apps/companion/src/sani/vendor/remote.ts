// Vendored from Sani 2396a9b6b6532fd33a822ba30a74d4b53f4bab90 (MIT; see adjacent LICENSE).
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

export interface OAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
}

export type Auth =
  | { kind: 'bearer'; token: string }
  | { kind: 'oauth'; issuer: string; state: OAuthState; scope?: string };

export interface RemoteOptions {
  url: string;
  auth: Auth;
  saveOAuth: (state: OAuthState) => void;
  callbackUrl: string;
  allowInsecureLoopback?: boolean;
  deferOutputValidation?: boolean;
}

const timeout = 15_000;
const maxResponseBytes = 1_048_576;
const maxTools = 512;
const globalIPv6 = ipaddr.IPv6.parse('2000::');
const githubOAuthIssuer = 'https://github.com/login/oauth';

class RemoteError extends Error {}

function addressAllowed(address: string, loopback: boolean): boolean {
  const ip = ipaddr.process(address);
  if (loopback) return ip.range() === 'loopback';
  return ip.range() === 'unicast' && (!(ip instanceof ipaddr.IPv6) || ip.match(globalIPv6, 3));
}

function endpoint(raw: string | URL, allowLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteError('Enter a valid remote URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const literal = isIP(host) !== 0;
  const localhost = host === 'localhost' || (literal && addressAllowed(host, true));
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopback && localhost)) ||
    url.username ||
    url.password ||
    url.href.includes('#') ||
    (literal && !addressAllowed(host, allowLoopback && localhost)) ||
    (!literal &&
      (host === 'localhost'
        ? !allowLoopback
        : !host.includes('.') || /\.(?:localhost|local|internal|home\.arpa)$/.test(host)))
  ) {
    throw new RemoteError('Use a public HTTPS URL without credentials or fragments.');
  }
  return url;
}

export function normalizeRemoteUrl(raw: string, allowInsecureLoopback = false): string {
  const url = endpoint(raw, allowInsecureLoopback);
  if (url.href.includes('?')) throw new RemoteError('Remote URLs must not include a query.');
  return url.href;
}

function safeLookup(allowLoopback: boolean): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '');
        return;
      }
      const onlyLoopback = allowLoopback && hostname.replace(/\.$/, '') === 'localhost';
      const allowed = addresses.filter(({ address }) => addressAllowed(address, onlyLoopback));
      const first = allowed[0];
      if (!first) {
        callback(new RemoteError('Remote hostname did not resolve to a permitted address.'), '');
      } else if (options.all) {
        callback(null, allowed);
      } else {
        callback(null, first.address, first.family);
      }
    });
  };
}

const publicAgent = new Agent({ connect: { lookup: safeLookup(false) } });
const fixtureAgent = new Agent({ connect: { lookup: safeLookup(true) } });

async function boundResponse(response: Response): Promise<Response> {
  if (!response.body) return response;
  if (Number(response.headers.get('content-length')) > maxResponseBytes) {
    await response.body.cancel();
    throw new RemoteError('Remote response is too large.');
  }
  let size = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxResponseBytes) throw new RemoteError('Remote response is too large.');
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function rpcMethod(body: RequestInit['body']): string | undefined {
  if (typeof body !== 'string') return;
  const data: unknown = JSON.parse(body);
  if (
    typeof data === 'object' &&
    data !== null &&
    'method' in data &&
    typeof data.method === 'string'
  )
    return data.method;
}

export class Remote {
  readonly #options: RemoteOptions;
  readonly #url: URL;
  readonly #issuer: URL | undefined;
  readonly #allowLoopback: boolean;
  #oauth: OAuthState;

  constructor(options: RemoteOptions) {
    this.#options = options;
    this.#allowLoopback = options.allowInsecureLoopback ?? false;
    this.#url = new URL(normalizeRemoteUrl(options.url, this.#allowLoopback));
    this.#issuer =
      options.auth.kind === 'oauth'
        ? new URL(normalizeRemoteUrl(options.auth.issuer, this.#allowLoopback))
        : undefined;
    this.#oauth = options.auth.kind === 'oauth' ? options.auth.state : {};
  }

  #store(state: OAuthState): void {
    this.#options.saveOAuth(state);
    this.#oauth = state;
  }

  #checkIssuer(value?: string): void {
    if (
      !this.#issuer ||
      !value ||
      normalizeRemoteUrl(value, this.#allowLoopback) !== this.#issuer.href
    ) {
      throw new RemoteError('The platform advertised a different OAuth issuer.');
    }
  }

  #issuerEndpoint(value: string | URL): URL {
    const url = endpoint(value, this.#allowLoopback);
    if (url.origin !== this.#issuer?.origin)
      throw new RemoteError('OAuth endpoint is outside the approved issuer.');
    return url;
  }

  #checkDiscovery(discovery: OAuthDiscoveryState): void {
    this.#checkIssuer(discovery.authorizationServerUrl);
    const metadata = discovery.authorizationServerMetadata;
    if (!metadata) throw new RemoteError('The platform did not publish OAuth server metadata.');
    this.#checkIssuer(metadata.issuer);
    this.#issuerEndpoint(metadata.authorization_endpoint);
    this.#issuerEndpoint(metadata.token_endpoint);
    if (metadata.registration_endpoint) this.#issuerEndpoint(metadata.registration_endpoint);
    const resource = discovery.resourceMetadata?.resource;
    if (resource && normalizeRemoteUrl(resource, this.#allowLoopback) !== this.#url.href) {
      throw new RemoteError('OAuth resource is outside the approved MCP connection.');
    }
  }

  #provider(
    begin?: { state: string; redirect: (url: string) => void },
    exchange = false,
  ): OAuthClientProvider {
    return {
      redirectUrl: this.#options.callbackUrl,
      clientMetadata: {
        client_name: 'Sani',
        redirect_uris: [this.#options.callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      ...(begin && { state: () => begin.state }),
      clientInformation: () => {
        const credentials = this.#oauth.clientInformation;
        if (credentials) this.#checkIssuer(credentials.issuer);
        if (this.#issuer?.href === githubOAuthIssuer) {
          if (!credentials?.client_id || !credentials.client_secret) {
            throw new RemoteError('Enter the client ID and secret for a registered GitHub App.');
          }
          // GitHub documents form authentication and omits the metadata hint the SDK needs.
          return {
            ...credentials,
            redirect_uris: [this.#options.callbackUrl],
            token_endpoint_auth_method: 'client_secret_post',
          };
        }
        return credentials;
      },
      saveClientInformation: (clientInformation) => {
        this.#checkIssuer(clientInformation.issuer);
        this.#store({ ...this.#oauth, clientInformation });
      },
      tokens: () => {
        const tokens = begin ? undefined : this.#oauth.tokens;
        if (tokens) this.#checkIssuer(tokens.issuer);
        return tokens;
      },
      saveTokens: (tokens) => {
        this.#checkIssuer(tokens.issuer);
        const refresh = exchange ? undefined : this.#oauth.tokens?.refresh_token;
        this.#store({
          ...this.#oauth,
          tokens: tokens.refresh_token || !refresh ? tokens : { ...tokens, refresh_token: refresh },
        });
      },
      discoveryState: () => {
        if (this.#oauth.discovery) this.#checkDiscovery(this.#oauth.discovery);
        return this.#oauth.discovery;
      },
      saveDiscoveryState: (discovery) => {
        this.#checkDiscovery(discovery);
        this.#store({ ...this.#oauth, discovery });
      },
      redirectToAuthorization: (url) => {
        if (!begin) throw new RemoteError('Reconnect the platform in Sani before using it.');
        begin.redirect(this.#issuerEndpoint(url).href);
      },
      saveCodeVerifier: (verifier) => {
        if (!begin) throw new RemoteError('Reconnect the platform in Sani before using it.');
        this.#store({ ...this.#oauth, verifier });
      },
      codeVerifier: () => {
        if (!this.#oauth.verifier) throw new RemoteError('OAuth approval is missing or expired.');
        return this.#oauth.verifier;
      },
      validateResourceURL: (_server, resource) => {
        if (resource && normalizeRemoteUrl(resource, this.#allowLoopback) !== this.#url.href) {
          throw new RemoteError('OAuth resource is outside the approved MCP connection.');
        }
        return Promise.resolve(this.#url);
      },
    };
  }

  #checkOAuthRequest(url: URL, method: string, headers: Headers): void {
    if (!this.#issuer)
      throw new RemoteError('Outbound request is outside the approved MCP connection.');
    const metadata = this.#oauth.discovery?.authorizationServerMetadata;
    const resourceDiscovery =
      url.origin === this.#url.origin &&
      /^\/\.well-known\/oauth-protected-resource(?:\/|$)/.test(url.pathname);
    const issuerDiscovery =
      url.origin === this.#issuer.origin &&
      /\/\.well-known\/(?:oauth-authorization-server|openid-configuration)(?:\/|$)/.test(
        url.pathname,
      );
    if (method === 'GET' && !headers.has('Authorization') && (resourceDiscovery || issuerDiscovery))
      return;
    if (
      method === 'POST' &&
      url.origin === this.#issuer.origin &&
      metadata &&
      [metadata.registration_endpoint, metadata.token_endpoint].some(
        (value) => value && endpoint(value, this.#allowLoopback).href === url.href,
      )
    )
      return;
    throw new RemoteError('Outbound OAuth request is outside the approved endpoints.');
  }

  #fetch(signal: AbortSignal, mcp: boolean, authorizeCall?: () => void): FetchLike {
    let toolSent = false;
    let codeSent = false;
    return async (raw, init = {}) => {
      const url = endpoint(raw, this.#allowLoopback);
      const method = init.method?.toUpperCase() ?? 'GET';
      const headers = new Headers(init.headers);
      const resourceRequest = mcp && url.href === this.#url.href;
      let toolCall = false;
      if (resourceRequest) {
        // Sani waits for each POST's result and does not subscribe to server-initiated events.
        if (method === 'GET') return new Response(null, { status: 405 });
        if (method !== 'POST' && method !== 'DELETE')
          throw new RemoteError('Unexpected MCP transport method.');
        toolCall = method === 'POST' && rpcMethod(init.body) === 'tools/call';
        if (toolCall) {
          if (toolSent || !authorizeCall) throw new RemoteError('Approval already spent.');
          authorizeCall();
          toolSent = true;
        }
      } else {
        this.#checkOAuthRequest(url, method, headers);
        if (
          init.body instanceof URLSearchParams &&
          init.body.get('grant_type') === 'authorization_code'
        ) {
          if (codeSent) throw new RemoteError('OAuth authorization code already used.');
          codeSent = true;
        }
      }

      const request: RequestInit = {
        ...init,
        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
        redirect: 'error',
      };
      // Node 22 accepts this dispatcher through Undici's runtime interface.
      Object.assign(request, { dispatcher: this.#allowLoopback ? fixtureAgent : publicAgent });
      const response = await fetch(url, request);
      if (toolCall && (response.status === 401 || response.status === 403)) {
        await response.body?.cancel();
        throw new RemoteError('The platform refused the approved request.');
      }
      return boundResponse(response);
    };
  }

  async startOAuth(state: string): Promise<string> {
    const connection = this.#options.auth;
    if (connection.kind !== 'oauth') throw new RemoteError('This connection uses a saved token.');
    let redirect: string | undefined;
    try {
      await auth(
        this.#provider({
          state,
          redirect: (url) => {
            redirect = url;
          },
        }),
        {
          serverUrl: this.#url,
          ...(connection.scope !== undefined && { scope: connection.scope }),
          fetchFn: this.#fetch(AbortSignal.timeout(timeout), false),
        },
      );
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError('Could not start authorization with the platform.');
    }
    if (!redirect) throw new RemoteError('The platform did not return an authorization link.');
    return redirect;
  }

  async finishOAuth(code: string): Promise<void> {
    if (this.#options.auth.kind !== 'oauth')
      throw new RemoteError('This connection uses a saved token.');
    try {
      const result = await auth(this.#provider(undefined, true), {
        serverUrl: this.#url,
        authorizationCode: code,
        fetchFn: this.#fetch(AbortSignal.timeout(timeout), false),
      });
      if (result !== 'AUTHORIZED')
        throw new RemoteError('The platform did not authorize the connection.');
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError('Could not complete authorization with the platform.');
    } finally {
      const persisted = { ...this.#oauth };
      delete persisted.verifier;
      this.#store(persisted);
    }
  }

  async #list(client: Client, signal: AbortSignal): Promise<Tool[]> {
    const tools = new Map<string, Tool>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const params = cursor ? { cursor } : undefined;
      // A registered server's unrelated tools must not compile output schemas in this client.
      const result = this.#options.deferOutputValidation
        ? await client.request(
            { method: 'tools/list', ...(params && { params }) },
            ListToolsResultSchema,
            { signal },
          )
        : await client.listTools(params, { signal });
      for (const tool of result.tools) {
        if (tools.has(tool.name) || tools.size >= maxTools)
          throw new RemoteError('Remote tool list is too large or ambiguous.');
        tools.set(tool.name, tool);
      }
      cursor = result.nextCursor;
      if (!cursor) return [...tools.values()];
    }
    throw new RemoteError('Remote tool list is too large.');
  }

  async #withClient<T>(
    run: (client: Client, signal: AbortSignal) => Promise<T>,
    authorizeCall?: () => void,
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeout);
    const authorization = this.#options.auth;
    const transport = new StreamableHTTPClientTransport(this.#url, {
      fetch: this.#fetch(signal, true, authorizeCall),
      ...(authorization.kind === 'oauth'
        ? { authProvider: this.#provider() }
        : { requestInit: { headers: { Authorization: `Bearer ${authorization.token}` } } }),
    });
    const client = new Client({ name: 'sani', version: '1.0.0-rc.3' });
    try {
      await client.connect(transport, { signal });
      return await run(client, signal);
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError('The remote MCP operation failed.');
    } finally {
      if (transport.sessionId) await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  }

  discover(): Promise<Tool[]> {
    return this.#withClient((client, signal) => this.#list(client, signal));
  }

  call(
    tool: string,
    args: Record<string, unknown> | ((definition: Tool) => Record<string, unknown>),
    beforeDispatch?: (tools: Tool[]) => void,
  ): Promise<CallToolResult> {
    let tools: Tool[] = [];
    return this.#withClient(
      async (client, signal) => {
        tools = await this.#list(client, signal);
        const definition = tools.find(({ name }) => name === tool);
        if (!definition) throw new RemoteError('The platform no longer offers this tool.');
        const arguments_ = typeof args === 'function' ? args(definition) : args;
        const result = await client.callTool(
          { name: tool, arguments: arguments_ },
          CallToolResultSchema,
          { signal },
        );
        return CallToolResultSchema.parse(result);
      },
      () => beforeDispatch?.(tools),
    );
  }
}
