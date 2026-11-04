import { isRecord } from './util.ts';

export const PROVIDER_ERROR_HEADER = 'X-Nix-Provider-Error';

export class ProviderFailure extends Error {
  readonly provider: string;
  readonly status: number;
  readonly code: string;

  constructor(provider: string, status: number, code: string) {
    super('');
    this.provider = provider;
    this.status = status;
    this.code = code;
    const message = providerFailureMessage(provider, this.token());
    this.message =
      message !== ''
        ? `${message} (HTTP ${String(status)})`
        : `${provider} answered HTTP ${String(status)}`;
  }

  token(): string {
    return this.code === '' ? '' : `${this.provider}.${this.code}.${String(this.status)}`;
  }
}

export function providerFailureToken(error: unknown): string {
  return error instanceof ProviderFailure ? error.token() : '';
}

/** Only fixed messages cross the provider boundary; error text is used for classification only. */
export function providerFailureMessage(provider: string, token: string): string {
  if ((provider !== 'anthropic' && provider !== 'openrouter') || !token.startsWith(`${provider}.`))
    return '';
  const name = provider === 'anthropic' ? 'Claude' : 'OpenRouter';
  switch (token.slice(provider.length + 1)) {
    case 'credit_balance.400':
    case 'credit_balance.402':
      if (provider !== 'anthropic' && token.endsWith('.400')) return '';
      return `${name} reports that this API key has insufficient credit. Check API billing for the key, then try again.`;
    case 'authentication.401':
      return `${name} rejected the API key. Update it in Settings > Pets.`;
    case 'permission.403':
      return `${name} refused access for this API key. Check the key's permissions and API access.`;
    case 'rate_limited.429':
      return `${name} is rate limiting this API key. Wait briefly, then try again.`;
    case 'models_rejected.400':
      return provider === 'anthropic'
        ? `${name} rejected model discovery for this API key. Check its API access and billing, then try again.`
        : '';
    default:
      return '';
  }
}

/** Reads a provider body, refusing to hold more than `limit` bytes. */
export async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      void reader.cancel();
      throw new Error('provider response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function providerResponseError(
  provider: string,
  response: Response,
  models: boolean,
): Promise<ProviderFailure> {
  let code = '';
  switch (response.status) {
    case 401:
      code = 'authentication';
      break;
    case 403:
      code = 'permission';
      break;
    case 402:
      code = 'credit_balance';
      break;
    case 429:
      code = 'rate_limited';
      break;
    case 400:
      if (provider === 'anthropic') {
        try {
          const envelope: unknown = JSON.parse(await readBounded(response, 4 << 10));
          const error = isRecord(envelope) ? envelope.error : undefined;
          if (
            isRecord(error) &&
            error.type === 'invalid_request_error' &&
            typeof error.message === 'string' &&
            error.message !== ''
          ) {
            const message = error.message.toLowerCase();
            if (
              message.includes('credit balance') &&
              (message.includes('too low') || message.includes('insufficient'))
            ) {
              code = 'credit_balance';
            } else if (models) code = 'models_rejected';
          }
        } catch {
          // an unreadable body classifies as no code
        }
      }
      break;
    default:
      break;
  }
  void response.body?.cancel().catch(() => undefined);
  return new ProviderFailure(provider, response.status, code);
}
