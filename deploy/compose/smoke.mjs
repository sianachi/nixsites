#!/usr/bin/env node
// Exercise the public product path through nixctl, including the actual Go transfers.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const profile = process.env.NIXCTL_PROFILE;
const workspace = process.env.NIX_SMOKE_WORKSPACE;
const expectedOrigin = process.env.NIX_SMOKE_ORIGIN;
const cli = process.env.NIXCTL_BIN ?? join(dirname(fileURLToPath(import.meta.url)), 'nixctl.sh');
if (!profile || !workspace || !expectedOrigin) throw new Error('Set NIXCTL_PROFILE, NIX_SMOKE_WORKSPACE and NIX_SMOKE_ORIGIN.');
const expectedURL = new URL(expectedOrigin);
if (expectedURL.protocol !== 'https:' || expectedURL.href !== `${expectedURL.origin}/`) throw new Error('NIX_SMOKE_ORIGIN must be an HTTPS origin.');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['--profile', profile, '--json', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let diagnostics = '';
    let timedOut = false;
    // Keep CLI diagnostics private: they may contain sensitive response details. Only the
    // credential check below reads them, to classify a refusal, and it never echoes them.
    child.stderr.on('data', (data) => {
      if (diagnostics.length < 65_536) diagnostics += data;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 180_000);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 185_000);
    child.stdout.on('data', (data) => {
      output += data;
      if (output.length > 1_048_576) child.kill('SIGKILL');
    });
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (code !== 0 || timedOut) {
        const error = new Error(`nixctl ${args[0]} failed${timedOut ? ' (180s timeout)' : ''}; inspect job state using nixctl/MCP.`);
        Object.defineProperty(error, 'diagnostics', { value: diagnostics, enumerable: false });
        return reject(error);
      }
      try { resolve(JSON.parse(output)); } catch { reject(new Error(`nixctl ${args[0]} returned invalid JSON.`)); }
    });
  });
}

execFileSync('python3', ['--version']);
execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
// Core does not tell a token-authenticated caller its own expiry (the token list refuses token
// sessions), so the credential cannot be warned about ahead of time. Instead, fail on the exchange
// refusal with a reason and the rotation steps, before anything is pulled or stopped.
const rotation = `Rotate the release-check token: mint a new one (read and write scopes) as the release-check principal under Settings > Access tokens, run \`nixctl --profile ${profile} auth login --api-url ${expectedURL.origin} --token "$TOKEN"\` with the token read from a private prompt, then revoke the old token. See deploy/README.md, Prerequisites.`;
function credentialFailure(diagnostics) {
  const expired = /expired at (\S+?)\.?$/m.exec(diagnostics);
  if (expired) return `has an expired access token (expired ${expired[1]})`;
  const revoked = /was revoked at (\S+?)\.?$/m.exec(diagnostics);
  if (revoked) return `has a revoked access token (revoked ${revoked[1]})`;
  if (/suspended or deprovisioned/.test(diagnostics)) return 'acts as a principal that is suspended or deprovisioned';
  if (/not a personal access token that authenticates/.test(diagnostics)) return 'holds a token Core does not recognise';
  if (/No profile (called|is signed in)/.test(diagnostics)) return 'does not exist on this host';
  return null;
}
let auth;
try {
  auth = await run(['auth', 'status']);
} catch (error) {
  const reason = credentialFailure(error.diagnostics ?? '');
  if (reason === null) throw new Error(`nixctl profile '${profile}' could not authenticate against ${expectedURL.origin}; check the origin is reachable and run \`nixctl --profile ${profile} auth status\` by hand.`);
  throw new Error(`nixctl profile '${profile}' ${reason}. ${rotation}`);
}
if (auth.apiUrl?.replace(/\/$/, '') !== expectedURL.origin) throw new Error('nixctl profile URL does not match this deployment; refusing to verify another instance.');
await run(['item', 'ls', '--workspace', workspace]);
if (process.argv.includes('--preflight')) {
  console.log('nixctl authentication and smoke workspace are available.');
  process.exit(0);
}
// Checked after preflight, which runs against the stack being replaced. The app frames nothing over the network (previews use blob:/srcdoc frames).
const appIndex = await fetch(expectedURL, { redirect: 'manual' });
if (!/(^|;)\s*frame-ancestors 'none'\s*($|;)/.test(appIndex.headers.get('content-security-policy') ?? '') || appIndex.headers.get('x-frame-options') !== 'DENY') throw new Error("The app index must send frame-ancestors 'none' and X-Frame-Options DENY.");
const directory = await mkdtemp(join(tmpdir(), 'nix-release-smoke-'));
let root;
let failure;
try {
  const source = join(directory, 'release-smoke.txt');
  await writeFile(source, 'Nix release smoke test\n\nStorage transfer and document conversion verification.\n');
  const report = await run(['import', source, '--workspace', workspace]);
  root = report.rootItemId;
  if (!root || report.createdCount !== 2 || !report.atomic || report.omissions?.length || report.loss?.length) {
    throw new Error('Document import did not publish the expected note and retained attachment without omissions.');
  }
  console.log(`Document import passed; temporary root ${root}.`);
  const children = await run(['item', 'ls', '--workspace', workspace, '--parent', root]);
  const original = children.items?.find((item) => item.type === 'file');
  if (!original || children.items.length !== 1) throw new Error('Import did not retain exactly one original attachment.');
  const retained = join(directory, 'retained.txt');
  await run(['file', 'download', original.id, '--out', retained]);
  if (!(await readFile(source)).equals(await readFile(retained))) throw new Error('Retained attachment differs from the imported source.');
  console.log('Retained attachment download matches the imported source.');
  for (const [format, magic] of [['nix', 'PK'], ['pdf', '%PDF-'], ['docx', 'PK']]) {
    const out = join(directory, `export.${format}`);
    // Archive v1 cannot embed file bytes; verify the attachment separately above.
    const result = await run(['export', root, '--format', format, '--scope', 'item', '--out', out]);
    if (result.omissions?.length || result.omitted > 0) throw new Error(`${format} export omitted content.`);
    const bytes = await readFile(out);
    if (!bytes.subarray(0, magic.length).equals(Buffer.from(magic))) throw new Error(`${format} export has an invalid file signature.`);
    execFileSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'verify-artifact.py'), format, out], { stdio: 'pipe' });
    console.log(`${format} export and checksum-verified download passed (${bytes.length} bytes).`);
  }
} catch (error) {
  failure = error;
} finally {
  if (root) {
    try {
      await run(['item', 'rm', root, '--workspace', workspace]);
      console.log(`Temporary import ${root} soft-deleted.`);
    } catch {
      failure ??= new Error(`Cleanup failed: soft-delete temporary root ${root} in workspace ${workspace}.`);
      console.error(`Cleanup required: temporary root ${root}.`);
    }
  } else if (failure) {
    console.error('Import did not return a root ID. Inspect recent imports for a timed-out or partially published smoke job.');
  }
  await rm(directory, { recursive: true, force: true });
}
if (failure) throw failure;
console.log('Public import and export smoke checks passed. Browser sign-in, paste/drop uploads and collaboration still require the runbook checks.');
