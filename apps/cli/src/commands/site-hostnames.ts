/**
 * `nixctl site hostnames` and `nixctl site approvals` (ADR-0063 M5).
 *
 * Hostnames: attach a custom hostname, see the DNS records to create, check them, choose the
 * primary (canonical) hostname and whether an alias serves or redirects. Core looks DNS up itself
 * and decides; these commands only ask.
 *
 * Approvals: on a deployment whose operator approves each site's first publish, a manager asks
 * and an operator lists, approves or rejects. Approval publishes as the manager who asked.
 */

import { sites, type Site, type SiteServeMode } from '@nix/api-client';
import type { Command } from 'commander';
import { resolveSession, type Act, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

const SERVE_MODES: readonly SiteServeMode[] = ['serve', 'redirect'];

function serveModeOf(value: string): SiteServeMode {
  const mode = SERVE_MODES.find((candidate) => candidate === value);
  if (mode === undefined) throw new Error("The serve mode is 'serve' or 'redirect'.");
  return mode;
}

/** The hostnames of a site with their status and the records still to create, one per line. */
export function describeHostnames(site: Site): string {
  return site.hostnames
    .map((host) => {
      const flags = [host.kind, host.status, host.primary ? 'primary' : host.serveMode];
      if (host.managed) flags.push('managed by Nix');
      if (host.checkError !== null) flags.push(host.checkError);
      const records =
        host.status === 'verified' || host.managed
          ? []
          : host.records.map((record) => `    ${record.type} ${record.name} ${record.value}`);
      return [`${host.hostname}  (${flags.join(', ')})`, ...records].join('\n');
    })
    .join('\n');
}

async function show(
  profileName: string | undefined,
  run: (session: Awaited<ReturnType<typeof resolveSession>>) => Promise<Site>,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const site = await run(session);
  if (output.json || !output.isTty) printResult(site.hostnames, output);
  else process.stdout.write(`${describeHostnames(site)}\n`);
}

export async function addHostname(
  profileName: string | undefined,
  siteId: string,
  hostname: string,
  options: { readonly mode?: string | undefined },
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const mode = options.mode === undefined ? undefined : serveModeOf(options.mode);
  await show(
    profileName,
    (session) => session.client.execute(sites.addSiteHostname(siteId, hostname, mode)),
    output,
    deps,
  );
}

export async function removeHostname(
  profileName: string | undefined,
  siteId: string,
  hostname: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (!confirmed)
    throw new Error('Removing a hostname stops serving the site there. Pass --yes to confirm.');
  await show(
    profileName,
    (session) => session.client.execute(sites.removeSiteHostname(siteId, hostname)),
    output,
    deps,
  );
}

export async function requestApproval(
  profileName: string | undefined,
  siteId: string,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (!confirmed) {
    throw new Error(
      'Once approved, this content becomes public. Search engines and archives may keep copies. Pass --yes to confirm.',
    );
  }
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(sites.requestSiteApproval(siteId, true)), output);
}

export async function reject(
  profileName: string | undefined,
  siteId: string,
  note: string | undefined,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.execute(sites.rejectSitePublish(siteId, note)), output);
}

/** Adds `hostnames` and `approvals` under the `site` command. */
export function registerSiteHostingCommands(site: Command, act: Act): void {
  const hostnames = site
    .command('hostnames')
    .description("A site's hostnames: custom domains, aliases and the primary.");
  hostnames
    .command('list <siteId>')
    .description('Each hostname with its status, and the DNS records still to create.')
    .action((siteId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        show(
          profile,
          (session) => session.client.query(sites.getSite(siteId), { forceRefresh: true }),
          output,
        ),
      ),
    );
  hostnames
    .command('add <siteId> <hostname>')
    .description('Attach a custom hostname; it is served once its TXT record verifies it.')
    .option(
      '--mode <mode>',
      "while not primary: 'serve' (200, default) or 'redirect' (308 to the primary)",
    )
    .action((siteId: string, hostname: string, options: { mode?: string }, command: Command) =>
      act(command, (profile, output) => addHostname(profile, siteId, hostname, options, output)),
    );
  hostnames
    .command('remove <siteId> <hostname>')
    .description('Detach a custom hostname and delete the DNS records Nix created for it.')
    .option('--yes', 'confirm', false)
    .action((siteId: string, hostname: string, options: { yes?: boolean }, command: Command) =>
      act(command, (profile, output) =>
        removeHostname(profile, siteId, hostname, options.yes === true, output),
      ),
    );
  hostnames
    .command('verify <siteId> <hostname>')
    .description('Check the DNS records now.')
    .action((siteId: string, hostname: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        show(
          profile,
          (session) => session.client.execute(sites.verifySiteHostname(siteId, hostname)),
          output,
        ),
      ),
    );
  hostnames
    .command('primary <siteId> <hostname>')
    .description('Make a hostname the canonical one (takes effect in pages at the next publish).')
    .action((siteId: string, hostname: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        show(
          profile,
          (session) =>
            session.client.execute(sites.updateSiteHostname(siteId, hostname, { primary: true })),
          output,
        ),
      ),
    );
  hostnames
    .command('mode <siteId> <hostname> <mode>')
    .description("How a non-primary hostname answers: 'serve' or 'redirect'.")
    .action((siteId: string, hostname: string, mode: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => {
        const serveMode = serveModeOf(mode);
        return show(
          profile,
          (session) =>
            session.client.execute(sites.updateSiteHostname(siteId, hostname, { serveMode })),
          output,
        );
      }),
    );

  const approvals = site
    .command('approvals')
    .description("The operator's approval of each site's first publish.");
  approvals
    .command('request <siteId>')
    .description(
      'Ask the operator to approve the first publish; it starts on its own once approved.',
    )
    .option('--yes', 'confirm the content may become public', false)
    .action((siteId: string, options: { yes?: boolean }, command: Command) =>
      act(command, (profile, output) =>
        requestApproval(profile, siteId, options.yes === true, output),
      ),
    );
  approvals
    .command('list')
    .description('Sites waiting for approval (operators only).')
    .action((_options: unknown, command: Command) =>
      act(command, async (profile, output) => {
        const session = await resolveSession(profile);
        printResult(
          await session.client.query(sites.listSiteApprovals(), { forceRefresh: true }),
          output,
        );
      }),
    );
  approvals
    .command('approve <siteId>')
    .description('Approve; the publish runs as the manager who asked (operators only).')
    .action((siteId: string, _options: unknown, command: Command) =>
      act(command, async (profile, output) => {
        const session = await resolveSession(profile);
        printResult(await session.client.execute(sites.approveSitePublish(siteId)), output);
      }),
    );
  approvals
    .command('reject <siteId>')
    .description('Reject, with a note the managers see (operators only).')
    .option('--note <note>', 'why')
    .action((siteId: string, options: { note?: string }, command: Command) =>
      act(command, (profile, output) => reject(profile, siteId, options.note, output)),
    );
}
