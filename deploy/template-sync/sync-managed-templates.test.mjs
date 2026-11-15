import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SCRIPT = resolve(import.meta.dirname, 'sync-managed-templates.mjs');
const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

test('previews every archive before committing and atomically finalizes the directory', async () => {
  const fixture = await bootFixture([
    { name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: randomUUID() },
    { name: 'beta.nix', bytes: 'beta', key: 'beta', operationId: null },
  ]);

  const result = await fixture.run();

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /archive=operator\/alpha\.nix importId=.*stage=upload status=pending_upload/u);
  assert.match(result.stdout, /profile=alpha importId=.*stage=preview status=preview_ready/u);
  assert.match(result.stdout, /jobId=.*state=completed/u);
  assert.match(result.stdout, /stage=finalize status=completed activeStableKeys=2/u);
  assert.doesNotMatch(result.stdout, /short-lived-token|signature=capability|uploadUrl/u);
  assert.deepEqual(fixture.failures, []);
  assert.deepEqual(
    fixture.events.map((event) => event.kind),
    [
      'health',
      'health',
      'health',
      'discovery',
      'token',
      'sweep',
      'begin',
      'upload',
      'preview',
      'operation',
      'status',
      'begin',
      'upload',
      'preview',
      'operation',
      'status',
      'commit',
      'operation',
      'status',
      'commit',
      'operation',
      'status',
      'finalize',
    ],
  );
  assert.deepEqual(fixture.finalizations[0].activeStableKeys, ['alpha', 'beta']);
  assert.deepEqual(
    fixture.finalizations[0].imports.map((entry) => ({
      importId: entry.importId,
      stableKey: entry.stableKey,
      operationId: entry.operationId,
    })),
    fixture.records.map((entry) => ({
      importId: entry.importId,
      stableKey: entry.key,
      operationId: entry.operationId,
    })),
  );
});

test('combines built-ins and operator templates in one idempotent snapshot', async () => {
  const fixture = await bootFixture([
    { name: 'project.nix', source: 'builtin', bytes: 'project-v1', key: 'nix.project-hub', operationId: null },
    { name: 'custom.nix', source: 'operator', bytes: 'custom-v1', key: 'operator.custom', operationId: null },
  ]);

  const first = await fixture.run();
  const firstImportIds = fixture.records.map((record) => record.importId);
  const second = await fixture.run();

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(fixture.failures, []);
  assert.equal(fixture.finalizations.length, 2);
  for (const snapshot of fixture.finalizations) {
    assert.deepEqual(snapshot.activeStableKeys, ['nix.project-hub', 'operator.custom']);
    assert.deepEqual(snapshot.imports.map((entry) => entry.stableKey), ['nix.project-hub', 'operator.custom']);
  }
  assert.deepEqual(fixture.records.map((record) => record.importId), firstImportIds);
  assert.equal(fixture.events.filter((event) => event.kind === 'begin').length, 4);
});

test('retains durable imports for retry when a file changes after preview', async () => {
  const fixture = await bootFixture(
    [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: randomUUID() }],
    { changeAfterPreview: { name: 'alpha.nix', bytes: 'changed' } },
  );

  const result = await fixture.run();

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /changed after its durable preview/u);
  assert.deepEqual(fixture.events.filter((event) => event.kind === 'cancel'), []);
  assert.equal(fixture.events.some((event) => event.kind === 'commit'), false);
  assert.equal(fixture.finalizations.length, 0);
});

test('rejects duplicate managed keys before committing and retains the durable attempts', async () => {
  const fixture = await bootFixture([
    { name: 'alpha.nix', source: 'builtin', bytes: 'alpha', key: 'same', operationId: randomUUID() },
    { name: 'beta.nix', source: 'operator', bytes: 'beta', key: 'same', operationId: randomUUID() },
  ]);

  const result = await fixture.run();

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /declared by more than one file/u);
  assert.equal(fixture.events.some((event) => event.kind === 'commit'), false);
  assert.deepEqual(fixture.events.filter((event) => event.kind === 'cancel'), []);
});

test('does not upload an archive when the service credential is refused', async () => {
  const fixture = await bootFixture(
    [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: randomUUID() }],
    { tokenStatus: 401 },
  );

  const result = await fixture.run();

  assert.notEqual(result.code, 0);
  assert.equal(fixture.events.some((event) => event.kind === 'begin'), false);
  assert.equal(fixture.events.some((event) => event.kind === 'upload'), false);
});

test('refuses a discovered token endpoint outside the configured issuer origin', async () => {
  const fixture = await bootFixture(
    [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: randomUUID() }],
    { tokenEndpoint: 'https://credentials.example.test/token' },
  );

  const result = await fixture.run();

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /token_endpoint must use the configured issuer origin/u);
  assert.equal(fixture.events.some((event) => event.kind === 'token'), false);
  assert.equal(fixture.events.some((event) => event.kind === 'begin'), false);
});

test('bounds identity provider JSON responses', async () => {
  const fixture = await bootFixture(
    [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: randomUUID() }],
    { oversizedTokenResponse: true },
  );

  const result = await fixture.run();

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /JSON response exceeded the 65536 byte limit/u);
  assert.equal(fixture.events.some((event) => event.kind === 'begin'), false);
});

test('signs in with a Core access token and never contacts an identity provider', async () => {
  const fixture = await bootFixture(
    [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: null }],
    { accessToken: 'nix_pat_example' },
  );

  const result = await fixture.run();

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fixture.failures, []);
  assert.equal(fixture.events.filter((event) => event.kind === 'exchange').length, 1);
  assert.equal(fixture.events.some((event) => event.kind === 'discovery' || event.kind === 'token'), false);
  assert.equal(fixture.events.filter((event) => event.kind === 'finalize').length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /nix_pat_example|short-lived-token/u);
});

test('reacquires one token and retries one Core request after a 401', async () => {
  const fixture = await bootFixture(
    [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: null }],
    { firstAuthorizedRequestStatus: 401 },
  );

  const result = await fixture.run();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fixture.events.filter((event) => event.kind === 'token').length, 2);
  assert.equal(fixture.events.filter((event) => event.kind === 'sweep').length, 1);
  assert.equal(fixture.events.filter((event) => event.kind === 'finalize').length, 1);
});

test('refuses an oversized managed file before beginning or uploading it', async () => {
  const fixture = await bootFixture([]);
  const oversized = resolve(fixture.operatorDirectory, 'oversized.nix');
  await writeFile(oversized, '');
  await truncate(oversized, 64 * 1024 * 1024 + 1);

  const result = await fixture.run();

  assert.notEqual(result.code, 0);
  assert.equal(fixture.events.some((event) => event.kind === 'begin'), false);
  assert.equal(fixture.events.some((event) => event.kind === 'upload'), false);
});

test('bounds RabbitMQ operation polling and leaves the timed-out import resumable', async () => {
  const fixture = await bootFixture(
    [{ name: 'alpha.nix', bytes: 'alpha', key: 'alpha', operationId: randomUUID() }],
    { previewNeverCompletes: 'alpha.nix', operationTimeoutMs: 40 },
  );

  const result = await fixture.run();

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /did not finish before its deadline/u);
  assert.equal(fixture.events.filter((event) => event.kind === 'operation').length >= 1, true);
  assert.deepEqual(fixture.events.filter((event) => event.kind === 'cancel'), []);
});

async function bootFixture(files, options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'nix-template-boot-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const builtinDirectory = resolve(directory, 'builtin');
  const operatorDirectory = resolve(directory, 'operator');
  await mkdir(builtinDirectory, { recursive: true });
  await mkdir(operatorDirectory, { recursive: true });
  for (const file of files) await writeFile(resolve(file.source === 'builtin' ? builtinDirectory : operatorDirectory, file.name), file.bytes);

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = resolve(directory, 'service-account.json');
  await writeFile(
    keyFile,
    JSON.stringify({
      type: 'serviceaccount',
      userId: randomUUID(),
      keyId: randomUUID(),
      key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );

  const tokenFile = resolve(directory, 'access-token');
  await writeFile(tokenFile, `${options.accessToken ?? ''}\n`);

  const records = files.map((file) => ({
    ...file,
    importId: randomUUID(),
    previewOperationId: randomUUID(),
    commitOperationId: randomUUID(),
    templateId: randomUUID(),
    uploaded: null,
    previewDone: false,
    commitDone: false,
    changed: false,
  }));
  const events = [];
  const failures = [];
  let authorizedStatus = options.firstAuthorizedRequestStatus;
  const finalizations = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      failures.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) json(response, 500, { detail: failures.at(-1) });
      else response.end();
    });
  });

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', 'http://placeholder');
    const health = /^\/health\/(core|collaboration)$|^\/ready\/import$/u.exec(url.pathname);
    if (health !== null) {
      events.push({ kind: 'health', service: health[1] ?? 'import' });
      json(response, 200, { status: 'healthy' });
      return;
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      events.push({ kind: 'discovery' });
      json(response, 200, { token_endpoint: options.tokenEndpoint ?? `${origin(server)}/token` });
      return;
    }
    if (url.pathname === '/public/v1/auth/token' && request.method === 'POST') {
      events.push({ kind: 'exchange' });
      const { token } = JSON.parse((await body(request)).toString('utf8'));
      if (token !== options.accessToken) return unexpected(response, failures, 'The access token was not sent.');
      json(response, 200, { accessToken: 'short-lived-token', tokenType: 'Bearer', expiresInSeconds: 300 });
      return;
    }
    if (url.pathname === '/token') {
      events.push({ kind: 'token' });
      if (options.oversizedTokenResponse === true) {
        json(response, 200, { access_token: 'a'.repeat(65 * 1024), expires_in: 300 });
        return;
      }
      json(
        response,
        options.tokenStatus ?? 200,
        options.tokenStatus === 401
          ? { error: 'invalid_grant' }
          : { access_token: 'short-lived-token', expires_in: 300 },
      );
      return;
    }

    const objectMatch = /^\/objects\/([0-9a-f-]+)$/iu.exec(url.pathname);
    if (objectMatch?.[1] !== undefined && request.method === 'PUT') {
      const record = records.find((candidate) => candidate.importId === objectMatch[1]);
      if (record === undefined) return unexpected(response, failures, 'Unknown object upload.');
      if (request.headers.authorization !== undefined) {
        return unexpected(response, failures, 'The bearer token reached object storage.');
      }
      if (request.headers['content-type'] !== 'application/octet-stream') {
        return unexpected(response, failures, 'The object upload media type was not preserved.');
      }
      record.uploaded = await body(request);
      events.push({ kind: 'upload', importId: record.importId });
      response.writeHead(204).end();
      return;
    }

    if (authorizedStatus !== undefined && request.headers.authorization !== undefined) {
      const status = authorizedStatus;
      authorizedStatus = undefined;
      json(response, status, { detail: 'The access token was rejected.' });
      return;
    }
    if (url.pathname.startsWith('/api/') && request.headers.authorization !== 'Bearer short-lived-token') {
      json(response, 401, { detail: 'A bearer token is required.' });
      return;
    }

    if (
      url.pathname === `/api/v1/workspaces/${WORKSPACE}/managed-template-stages/sweep` &&
      request.method === 'POST'
    ) {
      events.push({ kind: 'sweep' });
      json(response, 200, { removed: 0, itemIds: [] });
      return;
    }
    if (
      url.pathname === `/api/v1/workspaces/${WORKSPACE}/managed-template-imports` &&
      request.method === 'POST'
    ) {
      const requestBody = JSON.parse((await body(request)).toString('utf8'));
      const record = records.find((candidate) => `${candidate.source ?? 'operator'}/${candidate.name}` === requestBody.managedSource);
      if (record === undefined) return unexpected(response, failures, 'Unknown managed template.');
      if (
        requestBody.fileName !== record.name ||
        requestBody.mediaType !== 'application/x-nix-template' ||
        requestBody.byteLength !== Buffer.byteLength(record.bytes) ||
        !/^managed-template-boot:[0-9a-f]{64}$/u.test(requestBody.idempotencyKey)
      ) {
        return unexpected(response, failures, 'The durable begin request was invalid.');
      }
      events.push({ kind: 'begin', importId: record.importId });
      json(response, 200, {
        id: record.importId,
        status: 'pending_upload',
        uploadUrl: `${origin(server)}/objects/${record.importId}?signature=capability`,
        capabilityExpiresAt: '2026-09-01T10:10:00Z',
        expiresAt: '2026-09-01T11:00:00Z',
      });
      return;
    }

    const previewMatch = /^\/api\/v1\/template-imports\/([0-9a-f-]+)\/preview$/iu.exec(
      url.pathname,
    );
    if (previewMatch?.[1] !== undefined && request.method === 'POST') {
      const record = byImport(records, previewMatch[1]);
      if (record.uploaded === null) return unexpected(response, failures, 'Preview preceded upload.');
      events.push({ kind: 'preview', importId: record.importId });
      json(response, 202, operation(record.previewOperationId, 'template.preview', 'queued'));
      return;
    }

    const commitMatch = /^\/api\/v1\/template-imports\/([0-9a-f-]+)\/commit$/iu.exec(
      url.pathname,
    );
    if (commitMatch?.[1] !== undefined && request.method === 'POST') {
      const record = byImport(records, commitMatch[1]);
      const requestBody = JSON.parse((await body(request)).toString('utf8'));
      if (requestBody.expectedDigest !== sha256(record.uploaded)) {
        return unexpected(response, failures, 'Commit did not use the preview digest.');
      }
      events.push({ kind: 'commit', importId: record.importId });
      json(response, 202, operation(record.commitOperationId, 'template.commit', 'queued'));
      return;
    }

    const operationMatch = /^\/api\/v1\/operations\/([0-9a-f-]+)$/iu.exec(url.pathname);
    if (operationMatch?.[1] !== undefined && request.method === 'GET') {
      const preview = records.find(
        (candidate) => candidate.previewOperationId === operationMatch[1],
      );
      if (preview !== undefined) {
        events.push({ kind: 'operation', phase: 'preview', importId: preview.importId });
        if (options.previewNeverCompletes === preview.name) {
          json(response, 200, operation(preview.previewOperationId, 'template.preview', 'running'));
          return;
        }
        preview.previewDone = true;
        json(response, 200, operation(preview.previewOperationId, 'template.preview', 'completed'));
        return;
      }
      const commit = records.find((candidate) => candidate.commitOperationId === operationMatch[1]);
      if (commit !== undefined) {
        events.push({ kind: 'operation', phase: 'commit', importId: commit.importId });
        commit.commitDone = true;
        json(response, 200, operation(commit.commitOperationId, 'template.commit', 'completed'));
        return;
      }
      return unexpected(response, failures, 'Unknown durable operation.');
    }

    const importMatch = /^\/api\/v1\/template-imports\/([0-9a-f-]+)$/iu.exec(url.pathname);
    if (importMatch?.[1] !== undefined && request.method === 'GET') {
      const record = byImport(records, importMatch[1]);
      events.push({
        kind: 'status',
        phase: record.commitDone ? 'commit' : 'preview',
        importId: record.importId,
      });
      if (
        record.previewDone &&
        !record.changed &&
        options.changeAfterPreview?.name === record.name
      ) {
        await writeFile(resolve(record.source === 'builtin' ? builtinDirectory : operatorDirectory, record.name), options.changeAfterPreview.bytes);
        record.changed = true;
      }
      json(response, 200, templateImport(record));
      return;
    }
    if (importMatch?.[1] !== undefined && request.method === 'DELETE') {
      const record = byImport(records, importMatch[1]);
      events.push({ kind: 'cancel', importId: record.importId });
      response.writeHead(204).end();
      return;
    }

    if (
      url.pathname === `/api/v1/workspaces/${WORKSPACE}/managed-templates/finalize` &&
      request.method === 'POST'
    ) {
      events.push({ kind: 'finalize' });
      const snapshot = JSON.parse((await body(request)).toString('utf8'));
      finalizations.push(snapshot);
      json(response, 200, { activated: 1, unchanged: 1, retired: 0 });
      return;
    }
    unexpected(response, failures, `Unexpected route ${request.method} ${url.pathname}.`);
  }

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  cleanup.push(
    () =>
      new Promise((resolveClose) => {
        server.close(resolveClose);
      }),
  );

  return {
    directory,
    builtinDirectory,
    operatorDirectory,
    events,
    failures,
    records,
    finalizations,
    run: () =>
      child(SCRIPT, {
        NIX_TEMPLATE_BOOT_DIRECTORY: operatorDirectory,
        NIX_TEMPLATE_BOOT_BUILTIN_DIRECTORY: builtinDirectory,
        NIX_TEMPLATE_BOOT_WORKSPACE_ID: WORKSPACE,
        NIX_TEMPLATE_BOOT_CORE_URL: origin(server),
        NIX_TEMPLATE_BOOT_OBJECT_ORIGINS: origin(server),
        ...(options.accessToken === undefined
          ? {
              NIX_TEMPLATE_BOOT_OIDC_ISSUER: origin(server),
              NIX_TEMPLATE_BOOT_OIDC_AUDIENCE: 'project-id',
              NIX_TEMPLATE_BOOT_OIDC_SCOPE: 'openid urn:zitadel:iam:org:project:id:project-id:aud',
              NIX_TEMPLATE_BOOT_SERVICE_KEY_FILE: keyFile,
            }
          : { NIX_TEMPLATE_BOOT_ACCESS_TOKEN_FILE: tokenFile }),
        NIX_TEMPLATE_BOOT_REVISION: 'test-release',
        NIX_TEMPLATE_BOOT_HEALTH_URLS: [
          `${origin(server)}/health/core`,
          `${origin(server)}/health/collaboration`,
          `${origin(server)}/ready/import`,
        ].join(','),
        NIX_TEMPLATE_BOOT_HEALTH_TIMEOUT_MS: '1000',
        NIX_TEMPLATE_BOOT_OPERATION_TIMEOUT_MS: String(options.operationTimeoutMs ?? 1000),
        NIX_TEMPLATE_BOOT_POLL_INTERVAL_MS: '10',
      }),
  };
}

function templateImport(record) {
  const digest = sha256(record.uploaded);
  return {
    id: record.importId,
    workspaceId: WORKSPACE,
    status: record.commitDone ? 'staged' : record.previewDone ? 'preview_ready' : 'preview_queued',
    previewOperationId: record.previewOperationId,
    commitOperationId: record.commitDone ? record.commitOperationId : null,
    preview: record.previewDone
      ? {
          profile: { key: record.key },
          digest,
          rootItemType: 'note',
          itemCount: 1,
          bodyCount: 1,
          viewCount: 0,
        }
      : null,
    result: record.commitDone
      ? {
          operationId: record.operationId,
          templateId: record.templateId,
          stableKey: record.key,
          digest,
          unchanged: record.operationId === null,
          writtenTargetItemIds: [],
        }
      : null,
    failureCode: null,
    expiresAt: '2026-09-01T11:00:00Z',
    completedAt: null,
  };
}

function operation(id, kind, status) {
  return {
    id,
    kind,
    status,
    result: null,
    errorCode: null,
    errorDetail: null,
    attempts: status === 'queued' ? 0 : 1,
    cancellationRequested: false,
    createdAt: '2026-09-01T10:00:00Z',
    completedAt: status === 'completed' ? '2026-09-01T10:00:01Z' : null,
  };
}

function byImport(records, importId) {
  const record = records.find((candidate) => candidate.importId === importId);
  if (record === undefined) throw new Error(`No fixture import ${importId}.`);
  return record;
}

function unexpected(response, failures, message) {
  failures.push(message);
  json(response, 500, { detail: message });
}

function origin(server) {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fixture server is not listening.');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function child(script, env) {
  return new Promise((resolveChild) => {
    const childProcess = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    childProcess.stdout.setEncoding('utf8');
    childProcess.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    childProcess.stderr.setEncoding('utf8');
    childProcess.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    childProcess.on('close', (code) => {
      resolveChild({ code, stdout, stderr });
    });
  });
}
