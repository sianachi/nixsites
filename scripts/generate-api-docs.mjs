/**
 * Publish the API reference from backend/openapi/nix-api.json.
 *
 * Writes:
 *   docs/site/nix-docs/generated/nix-api.json
 *   docs/site/nix-docs/generated/reference.md
 *   docs/site/nix-docs/generated/reference.html
 *   docs/site/nix-docs/generated/error-codes.md
 *   docs/site/nix-docs/markdown/api/reference.md
 *   docs/site/nix-docs/markdown/api/error-codes.md
 *
 * The markdown copies are what the docs snapshot publishes. The generated/
 * copies stay in place when a site export rebuilds markdown/.
 *
 * Usage:
 *   node scripts/generate-api-docs.mjs
 *   node scripts/generate-api-docs.mjs --check
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { capability } from './api-docs/capability.mjs';
import { scopeSentence, tokenScope } from './api-docs/scope.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = join(root, 'backend/openapi/nix-api.json');
const generatedDir = join(root, 'docs/site/nix-docs/generated');
const snapshotDir = join(root, 'docs/site/nix-docs/markdown/api');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const EXTRA_CODES = [
  [
    'request.rate_limited',
    'The client address, or a public form link, is over a limit. Retry-After is whole seconds.',
  ],
  ['request.body_too_large', 'The request body is over the route limit. Status 413.'],
  [
    'api.unexpected_error',
    'A failure with no feature code, including an unknown route. Clients should not branch on it beyond unexpected.',
  ],
  [
    'auth.unauthenticated',
    'No usable credentials, or a personal access token that does not authenticate.',
  ],
  ['auth.token_revoked', 'The personal access token was revoked.'],
  ['auth.token_expired', 'The personal access token is past the expiry chosen when it was minted.'],
  ['auth.principal_inactive', 'The person behind the token is suspended or deprovisioned.'],
  [
    'auth.insufficient_scope',
    'The token is valid and does not hold the scope this route requires.',
  ],
  [
    'auth.exchange_unconfigured',
    'This deployment has no signing key, so personal access tokens cannot buy sessions. Status 503.',
  ],
  [
    'auth.provisioning_unavailable',
    'First sign-in could not provision the account. This is the browser sign-in path, not the token exchange.',
  ],
  [
    'paging.invalid_cursor',
    'A list cursor is malformed or longer than 512 characters. Status 422. Send the cursor back exactly as it was issued.',
  ],
];

/**
 * @param {string} text
 * @returns {Map<string, Set<string>>}
 */
export function codesInText(text) {
  const found = new Map();
  const pattern = /'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g;
  for (const match of text.matchAll(pattern)) {
    const code = match[1];
    if (!found.has(code)) {
      found.set(code, new Set());
    }
  }
  return found;
}

/**
 * @param {unknown} document
 */
export function operationsFrom(document) {
  if (document === null || typeof document !== 'object' || !('paths' in document)) {
    throw new Error('OpenAPI document has no paths.');
  }
  const paths = /** @type {{ paths: Record<string, Record<string, unknown>> }} */ (document).paths;
  /** @type {Operation[]} */
  const operations = [];
  for (const path of Object.keys(paths).sort()) {
    const item = paths[path];
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined || typeof operation !== 'object') {
        continue;
      }
      const record = /** @type {Record<string, unknown>} */ (operation);
      const tags = Array.isArray(record.tags) ? record.tags.map(String) : ['Other'];
      operations.push({
        path,
        method: method.toUpperCase(),
        tag: tags[0] ?? 'Other',
        operationId: String(record.operationId ?? `${method}_${path}`),
        summary: typeof record.summary === 'string' ? record.summary : '',
        description: typeof record.description === 'string' ? record.description : '',
        parameters: parametersOf(item, record),
        requestBody: requestBodyOf(record),
        responses: responsesOf(record),
      });
    }
  }
  return operations;
}

/**
 * @typedef {object} Operation
 * @property {string} path
 * @property {string} method
 * @property {string} tag
 * @property {string} operationId
 * @property {string} summary
 * @property {string} description
 * @property {Parameter[]} parameters
 * @property {string | null} requestBody
 * @property {string[]} responses
 */

/**
 * @typedef {object} Parameter
 * @property {string} name
 * @property {string} location
 * @property {boolean} required
 * @property {string} type
 */

/**
 * @param {Record<string, unknown>} pathItem
 * @param {Record<string, unknown>} operation
 * @returns {Parameter[]}
 */
function parametersOf(pathItem, operation) {
  const combined = [];
  for (const source of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const entry of source) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }
      const parameter = /** @type {Record<string, unknown>} */ (entry);
      combined.push({
        name: String(parameter.name ?? ''),
        location: String(parameter.in ?? ''),
        required: parameter.required === true,
        type: schemaLabel(parameter.schema),
      });
    }
  }
  return combined;
}

/**
 * @param {Record<string, unknown>} operation
 * @returns {string | null}
 */
function requestBodyOf(operation) {
  const body = operation.requestBody;
  if (body === null || typeof body !== 'object') {
    return null;
  }
  const content = /** @type {Record<string, unknown>} */ (body).content;
  if (content === null || typeof content !== 'object') {
    return 'request body';
  }
  const json = /** @type {Record<string, unknown>} */ (content)['application/json'];
  if (json === null || typeof json !== 'object') {
    return Object.keys(content).join(', ') || 'request body';
  }
  return schemaLabel(/** @type {Record<string, unknown>} */ (json).schema);
}

/**
 * @param {Record<string, unknown>} operation
 * @returns {string[]}
 */
function responsesOf(operation) {
  const responses = operation.responses;
  if (responses === null || typeof responses !== 'object') {
    return [];
  }
  return Object.keys(responses).sort();
}

/**
 * @param {unknown} schema
 * @returns {string}
 */
function schemaLabel(schema) {
  if (schema === null || typeof schema !== 'object') {
    return 'value';
  }
  const record = /** @type {Record<string, unknown>} */ (schema);
  if (typeof record.$ref === 'string') {
    const name = record.$ref.split('/').pop();
    return name || 'value';
  }
  if (Array.isArray(record.type)) {
    return record.type.map(String).join(' | ');
  }
  if (typeof record.type === 'string') {
    return record.format ? `${record.type} (${record.format})` : record.type;
  }
  if (Array.isArray(record.oneOf) || Array.isArray(record.anyOf)) {
    return 'one of several shapes';
  }
  return 'value';
}

/**
 * @param {Operation[]} operations
 */
export function renderReferenceMarkdown(operations) {
  const lines = [];
  lines.push(
    '<!-- Generated by scripts/generate-api-docs.mjs from backend/openapi/nix-api.json. Do not edit by hand. -->',
  );
  lines.push('');
  lines.push('# API reference');
  lines.push('');
  lines.push(
    'Every operation below is copied from the OpenAPI document the server publishes (`backend/openapi/nix-api.json`). The summary and description are the server\'s own text. "Can" and "Cannot" say what that route changes. No route in this document replaces a note, canvas, or spreadsheet body; those bodies live in the collaboration service, and a REST edit of a note body is not in the API yet.',
  );
  lines.push('');
  lines.push(
    "Paths are Core's paths. A deployed Nix forwards `/api/*` and `POST /public/v1/auth/token` on the public origin. Health, the signing keys, and public forms are Core routes too; the production edge does not add a separate public route for every `/public` path.",
  );
  lines.push('');
  lines.push('## Operations');
  lines.push('');

  /** @type {Map<string, Operation[]>} */
  const byTag = new Map();
  for (const operation of operations) {
    const group = byTag.get(operation.tag) ?? [];
    group.push(operation);
    byTag.set(operation.tag, group);
  }
  const tags = [...byTag.keys()].sort((left, right) => left.localeCompare(right));
  for (const tag of tags) {
    lines.push(`- [${tag}](#${slug(tag)})`);
  }
  lines.push('');

  for (const tag of tags) {
    lines.push(`## ${tag}`);
    lines.push('');
    lines.push(`<a id="${slug(tag)}"></a>`);
    lines.push('');
    for (const operation of byTag.get(tag) ?? []) {
      lines.push(...renderOperation(operation));
    }
  }

  lines.push('## Properties');
  lines.push('');
  lines.push('- title: API reference');
  lines.push('');
  return `${lines.join('\n')}`;
}

/**
 * @param {Operation} operation
 * @returns {string[]}
 */
function renderOperation(operation) {
  const effect = capability(operation.method, operation.path);
  const scope = tokenScope(operation.method, operation.path);
  const lines = [];
  lines.push(`### ${operation.method} ${operation.path}`);
  lines.push('');
  lines.push(`<a id="${slug(operation.operationId)}"></a>`);
  lines.push('');
  if (operation.summary !== '') {
    lines.push(operation.summary);
    lines.push('');
  }
  lines.push(`Operation id: \`${operation.operationId}\`.`);
  lines.push('');
  lines.push(`**Can.** ${effect.can}`);
  lines.push('');
  lines.push(`**Cannot.** ${effect.cannot}`);
  lines.push('');
  lines.push(`**Token.** ${scopeSentence(scope)}`);
  lines.push('');
  if (operation.description !== '') {
    lines.push(operation.description);
    lines.push('');
  }
  if (operation.parameters.length > 0) {
    lines.push('Parameters:');
    lines.push('');
    for (const parameter of operation.parameters) {
      const required = parameter.required ? 'required' : 'optional';
      lines.push(
        `- \`${parameter.name}\` in ${parameter.location} (${required}, ${parameter.type})`,
      );
    }
    lines.push('');
  }
  if (operation.requestBody !== null) {
    lines.push(`Request body: \`${operation.requestBody}\`.`);
    lines.push('');
  }
  if (operation.responses.length > 0) {
    lines.push(`Responses: ${operation.responses.map((status) => `\`${status}\``).join(', ')}.`);
    lines.push('');
  }
  return lines;
}

const SERVER_CODE_PATTERNS = [
  /const string \w*Code = "([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"/g,
  /new NixError\(\s*"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"/g,
];

/**
 * Stable codes defined in the API project. Job names and routing keys are
 * not matched. Internal and worker boundaries are omitted.
 *
 * @param {string} apiRoot
 * @returns {string[]}
 */
export function serverErrorCodes(apiRoot) {
  /** @type {Set<string>} */
  const codes = new Set();
  walkCs(apiRoot, (text) => {
    for (const pattern of SERVER_CODE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const code = match[1];
        if (code.startsWith('internal.') || code.startsWith('worker.')) {
          continue;
        }
        codes.add(code);
      }
    }
  });
  return [...codes].sort();
}

/**
 * @param {string} directory
 * @param {(text: string) => void} visit
 */
function walkCs(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkCs(path, visit);
      continue;
    }
    if (entry.name.endsWith('.cs')) {
      visit(readFileSync(path, 'utf8'));
    }
  }
}

/**
 * @param {Operation[]} operations
 * @param {readonly string[]} serverCodes
 */
export function renderErrorCodesMarkdown(operations, serverCodes) {
  /** @type {Map<string, Set<string>>} */
  const mentioned = new Map();
  for (const operation of operations) {
    const found = codesInText(`${operation.description}\n${operation.summary}`);
    for (const code of found.keys()) {
      const where = mentioned.get(code) ?? new Set();
      where.add(`${operation.method} ${operation.path}`);
      mentioned.set(code, where);
    }
  }

  const lines = [];
  lines.push(
    '<!-- Generated by scripts/generate-api-docs.mjs from backend/openapi/nix-api.json. Do not edit by hand. -->',
  );
  lines.push('');
  lines.push('# Error codes');
  lines.push('');
  lines.push(
    'Clients branch on `code` in the problem body. The codes named inside operation descriptions are listed first, with the routes that name them. The codes after that are stamped by the server even when a description does not repeat them.',
  );
  lines.push('');
  lines.push('## Codes named on a route');
  lines.push('');
  const named = [...mentioned.keys()].sort();
  if (named.length === 0) {
    lines.push('None.');
    lines.push('');
  }
  for (const code of named) {
    const where = [...(mentioned.get(code) ?? [])].sort();
    lines.push(`### \`${code}\``);
    lines.push('');
    for (const route of where) {
      lines.push(`- ${route}`);
    }
    lines.push('');
  }

  lines.push('## Codes the server adds');
  lines.push('');
  lines.push(
    'These are part of the wire contract. A description may already name some of them; they are repeated here so a client can find them in one place.',
  );
  lines.push('');
  for (const [code, meaning] of EXTRA_CODES) {
    lines.push(`- \`${code}\`: ${meaning}`);
  }
  lines.push('');

  const already = new Set(named);
  for (const [code] of EXTRA_CODES) {
    already.add(code);
  }
  const rest = serverCodes.filter((code) => !already.has(code));
  lines.push('## Other codes defined in the server');
  lines.push('');
  lines.push(
    'Every remaining stable code constant and `NixError` literal in the API project. A route description names the ones that route returns. Codes under `internal` and `worker` are service boundaries and are not listed. This is the set the code defines, not a promise that each one can be produced by every client.',
  );
  lines.push('');
  for (const code of rest) {
    lines.push(`- \`${code}\``);
  }
  lines.push('');
  lines.push('## Properties');
  lines.push('');
  lines.push('- title: Error codes');
  lines.push('');
  return `${lines.join('\n')}`;
}

/**
 * @param {Operation[]} operations
 */
export function renderReferenceHtml(operations) {
  /** @type {Map<string, Operation[]>} */
  const byTag = new Map();
  for (const operation of operations) {
    const group = byTag.get(operation.tag) ?? [];
    group.push(operation);
    byTag.set(operation.tag, group);
  }
  const tags = [...byTag.keys()].sort((left, right) => left.localeCompare(right));

  const nav = tags
    .map((tag) => `<a href="#${escapeHtml(slug(tag))}">${escapeHtml(tag)}</a>`)
    .join('');

  const sections = tags
    .map((tag) => {
      const articles = (byTag.get(tag) ?? [])
        .map((operation) => {
          const effect = capability(operation.method, operation.path);
          const scope = tokenScope(operation.method, operation.path);
          const haystack = [
            operation.method,
            operation.path,
            operation.operationId,
            operation.summary,
            operation.description,
            operation.tag,
          ]
            .join(' ')
            .toLowerCase();
          const parameters =
            operation.parameters.length === 0
              ? ''
              : `<ul>${operation.parameters
                  .map(
                    (parameter) =>
                      `<li><code>${escapeHtml(parameter.name)}</code> in ${escapeHtml(parameter.location)} (${parameter.required ? 'required' : 'optional'}, ${escapeHtml(parameter.type)})</li>`,
                  )
                  .join('')}</ul>`;
          const body =
            operation.requestBody === null
              ? ''
              : `<p>Request body: <code>${escapeHtml(operation.requestBody)}</code>.</p>`;
          const responses =
            operation.responses.length === 0
              ? ''
              : `<p>Responses: ${operation.responses.map((status) => `<code>${escapeHtml(status)}</code>`).join(', ')}.</p>`;
          return `<article id="${escapeHtml(slug(operation.operationId))}" data-search="${escapeHtml(haystack)}">
<h3><span class="verb">${escapeHtml(operation.method)}</span> <code>${escapeHtml(operation.path)}</code></h3>
<p>${escapeHtml(operation.summary)}</p>
<p class="id">Operation id: <code>${escapeHtml(operation.operationId)}</code></p>
<p><strong>Can.</strong> ${escapeHtml(effect.can)}</p>
<p><strong>Cannot.</strong> ${escapeHtml(effect.cannot)}</p>
<p><strong>Token.</strong> ${escapeHtml(scopeSentence(scope))}</p>
${operation.description === '' ? '' : `<p>${escapeHtml(operation.description)}</p>`}
${parameters}
${body}
${responses}
</article>`;
        })
        .join('\n');
      return `<section id="${escapeHtml(slug(tag))}"><h2>${escapeHtml(tag)}</h2>${articles}</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nix API reference</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  header, main { padding: 1.25rem 1.5rem 2rem; max-width: 52rem; }
  nav { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin: 1rem 0; }
  input { width: 100%; max-width: 28rem; font: inherit; padding: 0.4rem 0.6rem; }
  article { border-top: 1px solid #8884; padding: 1rem 0; }
  .verb { font-weight: 650; }
  code { font-family: ui-monospace, monospace; font-size: 0.92em; }
  .id { color: #666; }
  @media (prefers-color-scheme: dark) { .id { color: #aaa; } }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
<h1>Nix API reference</h1>
<p>Generated from <code>backend/openapi/nix-api.json</code>. Summaries and descriptions are the server's text. Can and Cannot say what each route changes. No route in this document replaces a note, canvas, or spreadsheet body.</p>
<p>The guide to tokens, the first request, identifiers, resources, pagination, errors, rate limits, and versioning is <a href="../markdown/api/index.md">the API guide</a>.</p>
<label>Filter <input id="filter" type="search" placeholder="Path, summary, or operation id"></label>
<nav>${nav}</nav>
</header>
<main>
${sections}
</main>
<script>
  const filter = document.getElementById('filter');
  const articles = [...document.querySelectorAll('article')];
  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    for (const article of articles) {
      const haystack = article.getAttribute('data-search') || '';
      article.hidden = query !== '' && !haystack.includes(query);
    }
    for (const section of document.querySelectorAll('main section')) {
      const visible = section.querySelector('article:not([hidden])');
      section.hidden = visible === null;
    }
  });
</script>
</body>
</html>
`;
}

/**
 * @param {string} value
 */
function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * @param {string} value
 */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function main() {
  const check = process.argv.includes('--check');
  const contractBytes = readFileSync(contractPath);
  const document = JSON.parse(contractBytes.toString('utf8'));
  const operations = operationsFrom(document);
  if (operations.length === 0) {
    throw new Error('OpenAPI document has no operations.');
  }
  const serverCodes = serverErrorCodes(join(root, 'backend/src/Nix.Api'));
  const reference = renderReferenceMarkdown(operations);
  const errors = renderErrorCodesMarkdown(operations, serverCodes);
  const html = renderReferenceHtml(operations);
  /** @type {Record<string, string | Buffer>} */
  const files = {
    [join(generatedDir, 'nix-api.json')]: contractBytes,
    [join(generatedDir, 'reference.md')]: reference,
    [join(generatedDir, 'reference.html')]: html,
    [join(generatedDir, 'error-codes.md')]: errors,
    [join(snapshotDir, 'reference.md')]: reference,
    [join(snapshotDir, 'error-codes.md')]: errors,
  };

  const drifted = [];
  for (const [path, contents] of Object.entries(files)) {
    const expected = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    let current = null;
    try {
      current = readFileSync(path);
    } catch {
      current = null;
    }
    if (current === null || !current.equals(expected)) {
      drifted.push(path);
      if (!check) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, expected);
      }
    }
  }

  if (check && drifted.length > 0) {
    console.error('API reference is stale. Run: node scripts/generate-api-docs.mjs');
    for (const path of drifted) {
      console.error(`  ${path}`);
    }
    process.exit(1);
  }
  if (!check) {
    console.log(`Wrote the API reference (${operations.length} operations).`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
