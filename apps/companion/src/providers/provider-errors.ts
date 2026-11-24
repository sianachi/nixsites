import { isRecord } from '../shared/util.ts';

export const PROVIDER_ERROR_HEADER = 'X-Nix-Provider-Error';

export class ProviderThreadUnavailableError extends Error {
  constructor() {
    super("that conversation's thread is no longer available; start a new one");
  }
}

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
  if (
    !['anthropic', 'openrouter', 'openai'].includes(provider) ||
    !token.startsWith(`${provider}.`)
  )
    return '';
  const name =
    provider === 'anthropic' ? 'Claude' : provider === 'openai' ? 'OpenAI' : 'OpenRouter';
  switch (token.slice(provider.length + 1)) {
    case 'credit_balance.400':
    case 'credit_balance.402':
    case 'credit_balance.429':
      if (provider !== 'anthropic' && token.endsWith('.400')) return '';
      return `${name} reports that this API key has insufficient credit. Check API billing for the key, then try again.`;
    case 'authentication.401':
      return `${name} rejected the API key. Update it in Settings > Pets.`;
    case 'permission.403':
      return `${name} refused access for this API key. Check the key's permissions and API access.`;
    case 'rate_limited.429':
      return `${name} is rate limiting this API key. Wait briefly, then try again.`;
    case 'model_unavailable.404':
      return provider === 'openai'
        ? 'OpenAI could not use the selected model for this API key. Choose another model, then try again.'
        : '';
    case 'request_rejected.400':
      return provider === 'openai'
        ? 'OpenAI rejected the request. Try another model, or report this problem if it continues.'
        : '';
    case 'request_rejected.404':
      return provider === 'openai'
        ? 'OpenAI could not find the requested model or endpoint. Check the selected model and API access, then try again.'
        : '';
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

const OPENAI_REQUEST_CODES = new Set([
  'invalid_function_parameters',
  'unsupported_parameter',
  'unsupported_value',
  'invalid_value',
  'invalid_type',
  'context_length_exceeded',
  'model_not_found',
]);
const OPENAI_REQUEST_PARAM =
  /^(?:model|messages|tools|stream|tools\[(?:0|[1-9]\d?)\]\.function(?:\.(?:name|parameters|description))?)$/;

function openaiRequestDiagnostic(error: unknown): string {
  if (!isRecord(error)) return '';
  const details: string[] = [];
  if (typeof error.code === 'string' && OPENAI_REQUEST_CODES.has(error.code))
    details.push(`code=${error.code}`);
  if (error.type === 'invalid_request_error') details.push('type=invalid_request_error');
  if (
    details.length > 0 &&
    typeof error.param === 'string' &&
    error.param.trim() === error.param &&
    OPENAI_REQUEST_PARAM.test(error.param)
  )
    details.push(`param=${error.param}`);
  return details.join(', ');
}

export async function providerResponseError(
  provider: string,
  response: Response,
  models: boolean,
): Promise<ProviderFailure> {
  let code = '';
  let diagnostic = '';
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
      // OpenAI answers an exhausted quota with the same status as a rate limit.
      if (provider === 'openai') {
        try {
          const envelope: unknown = JSON.parse(await readBounded(response, 4 << 10));
          const error = isRecord(envelope) ? envelope.error : undefined;
          if (isRecord(error) && error.code === 'insufficient_quota') code = 'credit_balance';
        } catch {
          // an unreadable body stays a rate limit
        }
      }
      break;
    case 400:
      if (provider === 'openai') {
        code = 'request_rejected';
        try {
          const envelope: unknown = JSON.parse(await readBounded(response, 4 << 10));
          diagnostic = openaiRequestDiagnostic(isRecord(envelope) ? envelope.error : undefined);
        } catch {
          // An unreadable body keeps the fixed failure without diagnostic details.
        }
      } else if (provider === 'anthropic') {
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
    case 404:
      if (provider === 'openai') {
        code = 'request_rejected';
        try {
          const envelope: unknown = JSON.parse(await readBounded(response, 4 << 10));
          const error = isRecord(envelope) ? envelope.error : undefined;
          if (isRecord(error) && error.code === 'model_not_found') code = 'model_unavailable';
        } catch {
          // An unreadable body keeps the fixed status-based failure.
        }
      }
      break;
    default:
      break;
  }
  void response.body?.cancel().catch(() => undefined);
  const failure = new ProviderFailure(provider, response.status, code);
  if (diagnostic !== '') failure.message += ` [${diagnostic}]`;
  return failure;
}
