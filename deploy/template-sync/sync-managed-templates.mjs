import { createHash, randomUUID, sign } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const directory = required('NIX_TEMPLATE_BOOT_DIRECTORY');
const builtInDirectory = required('NIX_TEMPLATE_BOOT_BUILTIN_DIRECTORY');
const workspaceId = required('NIX_TEMPLATE_BOOT_WORKSPACE_ID');
const coreBaseUrl = serviceOrigin(required('NIX_TEMPLATE_BOOT_CORE_URL'), 'NIX_TEMPLATE_BOOT_CORE_URL');
const objectOrigins = configuredOrigins(required('NIX_TEMPLATE_BOOT_OBJECT_ORIGINS'));
const issuer = serviceOrigin(required('NIX_TEMPLATE_BOOT_OIDC_ISSUER'), 'NIX_TEMPLATE_BOOT_OIDC_ISSUER');
const audience = required('NIX_TEMPLATE_BOOT_OIDC_AUDIENCE');
const scope = required('NIX_TEMPLATE_BOOT_OIDC_SCOPE');
const serviceKeyFile = required('NIX_TEMPLATE_BOOT_SERVICE_KEY_FILE');
const syncRevision = required('NIX_TEMPLATE_BOOT_REVISION');
const inspectOperationId = process.env.NIX_TEMPLATE_BOOT_INSPECT_OPERATION_ID ?? null;
const healthUrls = required('NIX_TEMPLATE_BOOT_HEALTH_URLS')
  .split(',')
  .map((entry) => strip(entry.trim()));
const healthTimeoutMs = positiveInteger(
  process.env.NIX_TEMPLATE_BOOT_HEALTH_TIMEOUT_MS ?? '180000',
  'NIX_TEMPLATE_BOOT_HEALTH_TIMEOUT_MS',
);
const operationTimeoutMs = positiveInteger(
  process.env.NIX_TEMPLATE_BOOT_OPERATION_TIMEOUT_MS ?? '600000',
  'NIX_TEMPLATE_BOOT_OPERATION_TIMEOUT_MS',
);
const pollIntervalMs = positiveInteger(
  process.env.NIX_TEMPLATE_BOOT_POLL_INTERVAL_MS ?? '500',
  'NIX_TEMPLATE_BOOT_POLL_INTERVAL_MS',
);
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;
const MAX_TEMPLATE_COUNT = 200;
const MAX_CORE_JSON_BYTES = 4 * 1024 * 1024;
const MAX_OIDC_JSON_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const TEMPLATE_MEDIA_TYPE = 'application/x-nix-template';

if (!uuid(workspaceId)) {
  throw new Error('NIX_TEMPLATE_BOOT_WORKSPACE_ID must be a UUID.');
}
if (healthUrls.length === 0 || healthUrls.some((url) => url.length === 0)) {
  throw new Error('NIX_TEMPLATE_BOOT_HEALTH_URLS must name one or more health endpoints.');
}
if (pollIntervalMs > operationTimeoutMs) {
  throw new Error('NIX_TEMPLATE_BOOT_POLL_INTERVAL_MS cannot exceed the operation timeout.');
}
if (inspectOperationId !== null && !uuid(inspectOperationId)) {
  throw new Error('NIX_TEMPLATE_BOOT_INSPECT_OPERATION_ID must be a UUID.');
}
if (syncRevision.length > 200 || [...syncRevision].some((character) => character.charCodeAt(0) < 0x20)) {
  throw new Error('NIX_TEMPLATE_BOOT_REVISION must be a bounded printable release identity.');
}
const audienceScope = `urn:zitadel:iam:org:project:id:${audience}:aud`;
if (!scope.split(/\s+/u).includes(audienceScope)) {
  throw new Error('NIX_TEMPLATE_BOOT_OIDC_SCOPE must include the configured project audience.');
}

await waitForHealth(healthUrls, healthTimeoutMs);
const discovery = await publicJson(`${issuer}/.well-known/openid-configuration`);
if (!record(discovery) || typeof discovery.token_endpoint !== 'string') {
  throw new Error('OIDC discovery did not publish a token_endpoint.');
}
const tokenEndpoint = oidcEndpoint(discovery.token_endpoint);
const serviceKey = parseServiceKey(await readFile(serviceKeyFile, 'utf8'));
const tokens = tokenProvider(tokenEndpoint, serviceKey);
if (inspectOperationId !== null) {
  const operation = parseOperation(
    await authorizedJson(`${coreBaseUrl}/api/v1/operations/${inspectOperationId}`, {
      method: 'GET',
    }),
    null,
    inspectOperationId,
  );
  console.log(
    JSON.stringify({
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      errorCode: operation.errorCode,
      errorDetail: redactUrls(operation.errorDetail),
      attempts: operation.attempts,
      cancellationRequested: operation.cancellationRequested,
      createdAt: operation.createdAt,
      completedAt: operation.completedAt,
    }),
  );
  process.exit(0);
}
const names = [
  ...(await managedNames(builtInDirectory, 'builtin')),
  ...(await managedNames(directory, 'operator')),
].sort((left, right) => left.managedSource.localeCompare(right.managedSource));

if (names.length > MAX_TEMPLATE_COUNT) {
    throw new Error(`The combined managed template directories may contain at most ${String(MAX_TEMPLATE_COUNT)} .nix files.`);
}

try {
  await authorizedJson(
    `${coreBaseUrl}/api/v1/workspaces/${workspaceId}/managed-template-stages/sweep`,
    { method: 'POST' },
  );

  const previews = [];
  const stableKeys = new Set();
  for (const source of names) {
    console.log(`[template-sync] archive=${source.managedSource} stage=begin`);
    const bytes = await readManagedFile(source);
    const sourceDigest = sha256(bytes);
    const begun = parseUpload(
      await authorizedJson(
        `${coreBaseUrl}/api/v1/workspaces/${workspaceId}/managed-template-imports`,
        jsonRequest('POST', {
          fileName: source.name,
          mediaType: TEMPLATE_MEDIA_TYPE,
          byteLength: bytes.byteLength,
          managedSource: source.managedSource,
          idempotencyKey: importIdempotencyKey(source.managedSource, sourceDigest),
        }),
      ),
      source.managedSource,
    );
    console.log(
      `[template-sync] archive=${source.managedSource} importId=${begun.id} stage=upload status=${begun.status}`,
    );
    if (begun.uploadUrl !== null) {
      await putCapability(begun.uploadUrl, bytes);
      console.log(
        `[template-sync] archive=${source.managedSource} importId=${begun.id} stage=upload status=completed`,
      );
    } else if (begun.status === 'pending_upload') {
      throw new Error(`Core did not provide an upload capability for ${source.managedSource}.`);
    }

    const previewJob = parseOperation(
      await authorizedJson(
        `${coreBaseUrl}/api/v1/template-imports/${begun.id}/preview`,
        { method: 'POST' },
      ),
      'template.preview',
    );
    await waitForOperation(
      previewJob,
      `archive=${source.managedSource} importId=${begun.id} stage=preview`,
    );
    const current = parseTemplateImport(
      await authorizedJson(`${coreBaseUrl}/api/v1/template-imports/${begun.id}`, {
        method: 'GET',
      }),
      begun.id,
    );
    if (current.preview === null || current.preview.digest !== sourceDigest) {
      throw new Error(`The durable preview for ${source.managedSource} did not describe its uploaded archive.`);
    }
    if (stableKeys.has(current.preview.stableKey)) {
      throw new Error(
        `Managed template key ${current.preview.stableKey} is declared by more than one file.`,
      );
    }
    stableKeys.add(current.preview.stableKey);
    console.log(
      `[template-sync] archive=${source.managedSource} profile=${current.preview.stableKey} importId=${begun.id} stage=preview status=${current.status}`,
    );
    previews.push({
      name: source.managedSource,
      source,
      importId: begun.id,
      digest: current.preview.digest,
      stableKey: current.preview.stableKey,
    });
  }

  const imports = [];
  for (const preview of previews) {
    console.log(
      `[template-sync] archive=${preview.name} profile=${preview.stableKey} importId=${preview.importId} stage=commit`,
    );
    const currentBytes = await readManagedFile(preview.source);
    if (sha256(currentBytes) !== preview.digest) {
      throw new Error(`Managed template ${preview.name} changed after its durable preview.`);
    }
    const commitJob = parseOperation(
      await authorizedJson(
        `${coreBaseUrl}/api/v1/template-imports/${preview.importId}/commit`,
        jsonRequest('POST', { expectedDigest: preview.digest }),
      ),
      'template.commit',
    );
    await waitForOperation(
      commitJob,
      `archive=${preview.name} profile=${preview.stableKey} importId=${preview.importId} stage=commit`,
    );
    const current = parseTemplateImport(
      await authorizedJson(`${coreBaseUrl}/api/v1/template-imports/${preview.importId}`, {
        method: 'GET',
      }),
      preview.importId,
    );
    if (
      current.result === null ||
      (current.status !== 'staged' && current.status !== 'completed') ||
      current.result.digest !== preview.digest ||
      current.result.stableKey !== preview.stableKey
    ) {
      throw new Error(`The managed template commit for ${preview.name} was incomplete.`);
    }
    console.log(
      `[template-sync] archive=${preview.name} profile=${current.result.stableKey} importId=${preview.importId} templateId=${current.result.templateId} stage=commit status=${current.status}`,
    );
    imports.push({ importId: preview.importId, ...current.result });
  }

  await authorizedJson(
    `${coreBaseUrl}/api/v1/workspaces/${workspaceId}/managed-templates/finalize`,
    jsonRequest('POST', {
      imports: imports.map((entry) => ({
        importId: entry.importId,
        operationId: entry.operationId,
        templateId: entry.templateId,
        stableKey: entry.stableKey,
        digest: entry.digest,
        writtenTargetItemIds: entry.writtenTargetItemIds,
      })),
      activeStableKeys: previews.map((preview) => preview.stableKey),
    }),
  );
  console.log(
    `[template-sync] stage=finalize status=completed activeStableKeys=${previews.length}`,
  );
} catch (error) {
  // Durable imports are deliberately retained after an interrupted run. A retry with the same
  // release identity resumes the exact jobs; Core's expiry reaper owns eventual cleanup when a
  // release is abandoned.
  throw error;
}

async function waitForOperation(initial, context) {
  const deadline = Date.now() + operationTimeoutMs;
  const started = Date.now();
  let operation = initial;
  let previousStatus = null;
  let lastHeartbeat = started;
  for (;;) {
    if (operation.status !== previousStatus) {
      console.log(
        `[template-sync] ${context} jobId=${operation.id} state=${operation.status} attempts=${operation.attempts}`,
      );
      previousStatus = operation.status;
    }
    if (operation.status === 'completed') return;
    if (operation.status === 'failed' || operation.status === 'cancelled') {
      throw new Error(
        redactUrls(operation.errorDetail) ??
          operation.errorCode ??
          `The ${operation.kind} operation ${operation.status}.`,
      );
    }
    if (Date.now() - lastHeartbeat >= 15_000) {
      console.log(
        `[template-sync] ${context} jobId=${operation.id} heartbeat elapsedSeconds=${Math.floor((Date.now() - started) / 1000)} state=${operation.status} attempts=${operation.attempts}`,
      );
      lastHeartbeat = Date.now();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`The ${operation.kind} operation did not finish before its deadline.`);
    }
    await delay(Math.min(pollIntervalMs, remaining));
    const requestRemaining = deadline - Date.now();
    if (requestRemaining <= 0) {
      throw new Error(`The ${operation.kind} operation did not finish before its deadline.`);
    }
    operation = parseOperation(
      await authorizedJson(
        `${coreBaseUrl}/api/v1/operations/${operation.id}`,
        { method: 'GET' },
        false,
        Math.min(REQUEST_TIMEOUT_MS, requestRemaining),
      ),
      operation.kind,
      operation.id,
    );
  }
}

async function putCapability(address, bytes) {
  const url = new URL(address);
  if (!objectOrigins.has(url.origin)) {
    throw new Error('Core returned an object capability outside the configured storage origins.');
  }
  if (url.username !== '' || url.password !== '' || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Core returned an invalid object upload capability.');
  }
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The object upload capability failed with HTTP ${String(response.status)}.`);
  }
}

function tokenProvider(tokenEndpoint, key) {
  let current = null;
  return {
    invalidate() {
      current = null;
    },
    async get() {
      if (current !== null && current.expiresAt - Date.now() >= 60_000) return current.value;
      const now = Math.floor(Date.now() / 1000);
      const assertion = signedJwt(
        { alg: 'RS256', kid: key.keyId, typ: 'JWT' },
        {
          iss: key.userId,
          sub: key.userId,
          aud: issuer,
          iat: now,
          exp: now + 300,
          jti: randomUUID(),
        },
        key.privateKey,
      );
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          scope,
          assertion,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      const answer = await boundedJson(response, MAX_OIDC_JSON_BYTES);
      if (!response.ok || !record(answer) || typeof answer.access_token !== 'string') {
        throw new Error(`OIDC JWT bearer exchange failed with HTTP ${String(response.status)}.`);
      }
      current = {
        value: answer.access_token,
        expiresAt: Date.now() + Number(answer.expires_in ?? 300) * 1000,
      };
      return current.value;
    },
  };
}

async function waitForHealth(urls, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (const url of urls) {
    for (;;) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) break;
      } catch {
        // The rollout may still be bringing this dependency up; retry within the one deadline.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${url}.`);
      }
      await delay(Math.min(1_000, Math.max(1, deadline - Date.now())));
    }
  }
}

async function authorizedJson(url, init, retried = false, timeoutMs = REQUEST_TIMEOUT_MS) {
  const token = await tokens.get();
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 && !retried) {
    tokens.invalidate();
    return await authorizedJson(url, init, true, timeoutMs);
  }
  const answer = await boundedJson(response, MAX_CORE_JSON_BYTES);
  if (!response.ok) {
    const detail =
      record(answer) && typeof answer.detail === 'string'
        ? answer.detail
        : 'No problem detail returned.';
    throw new Error(`${init.method} ${url} failed with HTTP ${String(response.status)}: ${detail}`);
  }
  return answer ?? {};
}

async function publicJson(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${String(response.status)}.`);
  return await boundedJson(response, MAX_OIDC_JSON_BYTES);
}

async function boundedJson(response, maximumBytes) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new Error(`JSON response exceeded the ${String(maximumBytes)} byte limit.`);
    }
  }
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error(`JSON response exceeded the ${String(maximumBytes)} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

async function managedNames(path, source) {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.nix'))
    .map((entry) => ({ name: entry.name, directory: path, managedSource: `${source}/${entry.name}` }));
}

async function readManagedFile(source) {
  const { name } = source;
  const path = join(source.directory, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_TEMPLATE_BYTES) {
    throw new Error(`Managed template ${name} is not a regular non-empty file of at most 64 MiB.`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw new Error(`Managed template ${name} changed outside the 1 byte to 64 MiB limit.`);
  }
  return bytes;
}

function parseUpload(value, name) {
  if (
    !record(value) ||
    !uuid(value.id) ||
    typeof value.status !== 'string' ||
    (value.uploadUrl !== null && typeof value.uploadUrl !== 'string')
  ) {
    throw new Error(`Core returned an invalid managed template import for ${name}.`);
  }
  return { id: value.id, status: value.status, uploadUrl: value.uploadUrl };
}

function parseOperation(value, expectedKind, expectedId = null) {
  if (
    !record(value) ||
    !uuid(value.id) ||
    (expectedId !== null && value.id !== expectedId) ||
    typeof value.kind !== 'string' ||
    (expectedKind !== null && value.kind !== expectedKind) ||
    !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(value.status) ||
    (value.errorCode !== null && typeof value.errorCode !== 'string') ||
    (value.errorDetail !== null && typeof value.errorDetail !== 'string') ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    typeof value.cancellationRequested !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    (value.completedAt !== null && typeof value.completedAt !== 'string')
  ) {
    throw new Error(`Core returned an invalid ${expectedKind ?? 'operation'} status.`);
  }
  return {
    id: value.id,
    kind: value.kind,
    status: value.status,
    errorCode: value.errorCode,
    errorDetail: value.errorDetail,
    attempts: value.attempts,
    cancellationRequested: value.cancellationRequested,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
  };
}

function redactUrls(value) {
  return value?.replace(/https?:\/\/[^\s)"']+/giu, '[url redacted]') ?? null;
}

function parseTemplateImport(value, expectedId) {
  if (
    !record(value) ||
    value.id !== expectedId ||
    value.workspaceId !== workspaceId ||
    typeof value.status !== 'string'
  ) {
    throw new Error('Core returned template import status for the wrong durable import.');
  }
  let preview = null;
  if (value.preview !== null) {
    if (
      !record(value.preview) ||
      !record(value.preview.profile) ||
      typeof value.preview.profile.key !== 'string' ||
      value.preview.profile.key.length === 0 ||
      value.preview.profile.key.length > 160 ||
      !digest(value.preview.digest)
    ) {
      throw new Error('Core returned an invalid managed template preview.');
    }
    preview = { stableKey: value.preview.profile.key, digest: value.preview.digest };
  }
  let result = null;
  if (value.result !== null) {
    if (
      !record(value.result) ||
      (value.result.operationId !== null && !uuid(value.result.operationId)) ||
      !uuid(value.result.templateId) ||
      typeof value.result.stableKey !== 'string' ||
      !digest(value.result.digest) ||
      !Array.isArray(value.result.writtenTargetItemIds) ||
      value.result.writtenTargetItemIds.length > 10_000 ||
      !value.result.writtenTargetItemIds.every(uuid) ||
      new Set(value.result.writtenTargetItemIds).size !== value.result.writtenTargetItemIds.length
    ) {
      throw new Error('Core returned an invalid managed template commit result.');
    }
    result = {
      operationId: value.result.operationId,
      templateId: value.result.templateId,
      stableKey: value.result.stableKey,
      digest: value.result.digest,
      writtenTargetItemIds: value.result.writtenTargetItemIds,
    };
  }
  return { status: value.status, preview, result };
}

function jsonRequest(method, value) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

function parseServiceKey(json) {
  const value = JSON.parse(json);
  if (
    !record(value) ||
    value.type !== 'serviceaccount' ||
    typeof value.userId !== 'string' ||
    typeof value.keyId !== 'string' ||
    typeof value.key !== 'string'
  ) {
    throw new Error('The mounted OIDC service-account key JSON is invalid.');
  }
  return { userId: value.userId, keyId: value.keyId, privateKey: value.key };
}

function signedJwt(header, payload, privateKey) {
  const input = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function importIdempotencyKey(name, sourceDigest) {
  const identity = createHash('sha256')
    .update(syncRevision)
    .update('\0')
    .update(workspaceId)
    .update('\0')
    .update(name)
    .update('\0')
    .update(sourceDigest)
    .digest('hex');
  return `managed-template-boot:${identity}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function digest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function uuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function configuredOrigins(value) {
  const origins = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parsed = new URL(entry);
      if (
        parsed.username !== '' ||
        parsed.password !== '' ||
        !['http:', 'https:'].includes(parsed.protocol)
      ) {
        throw new Error('NIX_TEMPLATE_BOOT_OBJECT_ORIGINS contains an invalid storage origin.');
      }
      return parsed.origin;
    });
  if (origins.length === 0) {
    throw new Error('NIX_TEMPLATE_BOOT_OBJECT_ORIGINS must name at least one storage origin.');
  }
  return new Set(origins);
}

function serviceOrigin(value, name) {
  const stripped = strip(value);
  const parsed = new URL(stripped);
  if (
    parsed.origin !== stripped ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !['http:', 'https:'].includes(parsed.protocol)
  ) {
    throw new Error(`${name} must be an HTTP or HTTPS origin with no path or credentials.`);
  }
  return stripped;
}

function oidcEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OIDC token_endpoint must be an absolute URL.');
  }
  if (
    parsed.origin !== issuer ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    !['http:', 'https:'].includes(parsed.protocol)
  ) {
    throw new Error('OIDC token_endpoint must use the configured issuer origin.');
  }
  return parsed.toString();
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function strip(value) {
  return value.replace(/\/+$/u, '');
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive safe integer.`);
  return parsed;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
