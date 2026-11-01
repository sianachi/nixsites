import type { Command } from 'commander';
import * as siteCommands from './sites.ts';
import { registerSiteHostingCommands } from './site-hostnames.ts';
import { collectOptional } from './program-support.ts';
import type { ConfirmCliOptions } from './program-support.ts';
import { type Act } from './shared.ts';

export function registerSiteCommands(program: Command, act: Act): void {
  // Sites publish an item's subtree as a static website. Core decides who may manage them; the
  // publish of a site that is not live, auto mode, a rollback, an unpublish and a delete each need
  // --yes.
  const site = program.command('site').description('Publish an item and its subtree as a website.');

  site
    .command('create <rootItemId>')
    .description('Make an item a draft site. Nothing is public until it is published.')
    .requiredOption('--slug <slug>', 'the first label of the default hostname')
    .option('--layout <layout>', 'docs or blog', 'docs')
    .action((rootItemId: string, options: { slug: string; layout: string }, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.createSite(profile, rootItemId, options, output),
      ),
    );

  site
    .command('get [siteId]')
    .description('Read a site, by id or by its root item.')
    .option('--item <itemId>', 'the root item instead of the site id')
    .action((siteId: string | undefined, options: { item?: string }, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.getSite(profile, { siteId, itemId: options.item }, output),
      ),
    );

  site
    .command('update <siteId>')
    .description('Change settings, the republish mode, exclusions or dated collections.')
    .option('--name <name>', 'the site name')
    .option('--description <text>', 'the one-line description')
    .option('--accent <hex>', 'the accent colour as #rrggbb')
    .option(
      '--nav <link>',
      'a top navigation link <label>=</path>; repeat; replaces the navigation',
      collectOptional,
    )
    .option('--footer <text>', 'the footer text')
    .option('--built-with-nix', 'show the "Built with Nix" footer link')
    .option('--no-built-with-nix', 'hide the "Built with Nix" footer link')
    .option('--noindex', 'hide the site from search engines (robots.txt and meta robots)')
    .option('--no-noindex', 'let search engines index the site again')
    .option('--author <name>', 'who writes the site, for search engines; "" clears it')
    .option('--typeface <face>', 'rounded (Nunito Sans), serif (Literata) or legible (Atkinson)')
    .option('--heading-mark <mark>', 'square, diamond or none')
    .option('--spacing <spacing>', 'compact, comfortable or airy')
    .option('--theme <itemId>', 'the page whose files are the custom layout\'s theme; "" clears it')
    .option('--layout <layout>', 'docs, blog or custom (custom needs --theme)')
    .option(
      '--mode <mode>',
      'manual, auto or on_release; auto publishes every saved edit on its own and needs --yes',
    )
    .option('--debounce <seconds>', 'settle time before an automatic rebuild, 60 to 3600')
    .option(
      '--exclude <itemId>',
      'an item to leave out; repeat; replaces the list',
      collectOptional,
    )
    .option(
      '--dated <spec>',
      'add or replace a dated collection <itemId>:<dateProp>[:<tagsProp>[:<coverProp>[:<summaryProp>]]]; repeat; others are kept',
      collectOptional,
    )
    .option('--undated <itemId>', 'stop treating a collection as dated; repeat', collectOptional)
    .option('--yes', 'confirm switching to auto mode', false)
    .action((siteId: string, options: siteCommands.UpdateSiteOptions, command: Command) =>
      act(command, (profile, output) => siteCommands.updateSite(profile, siteId, options, output)),
    );

  site
    .command('publish <siteId>')
    .description(
      'Build the site and take it live. Publishing a site that is not live (a draft or an unpublished site) needs --yes.',
    )
    .option(
      '--refresh-paths',
      're-derive the paths of pages whose path is not pinned; each old path keeps redirecting to the new one',
      false,
    )
    .option('--yes', 'confirm the content becomes public', false)
    .option('--wait', 'wait until the build is live or has failed', false)
    .option('--timeout <seconds>', 'how long --wait waits', '600')
    .action((siteId: string, options: siteCommands.PublishOptions, command: Command) =>
      act(command, (profile, output) => siteCommands.publishSite(profile, siteId, options, output)),
    );

  site
    .command('builds <siteId>')
    .description("A site's builds, newest first.")
    .action((siteId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => siteCommands.listBuilds(profile, siteId, output)),
    );

  site
    .command('build <siteId> <buildId>')
    .description('One build: status, page count and what could not be published.')
    .action((siteId: string, buildId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => siteCommands.getBuild(profile, siteId, buildId, output)),
    );

  site
    .command('pages <siteId>')
    .description("A site's page paths.")
    .action((siteId: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => siteCommands.listPages(profile, siteId, output)),
    );

  site
    .command('path <siteId> <itemId> <path>')
    .description('Set and pin one page path; the old path becomes a permanent redirect.')
    .action((siteId: string, itemId: string, path: string, _options: unknown, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.setPath(profile, siteId, itemId, path, output),
      ),
    );

  site
    .command('rollback <siteId> <buildId>')
    .description('Serve a previous build again, exactly as it was then.')
    .option('--yes', 'confirm re-serving that content', false)
    .action((siteId: string, buildId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.rollbackSite(profile, siteId, buildId, options.yes === true, output),
      ),
    );

  site
    .command('unpublish <siteId>')
    .description('Take the site down and delete its builds. Copies others made may remain.')
    .option('--yes', 'confirm this destructive operation', false)
    .action((siteId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.unpublishSite(profile, siteId, options.yes === true, output),
      ),
    );

  registerSiteHostingCommands(site, act);

  site
    .command('delete <siteId>')
    .description('Delete a site that is not live.')
    .option('--yes', 'confirm this destructive operation', false)
    .action((siteId: string, options: ConfirmCliOptions, command: Command) =>
      act(command, (profile, output) =>
        siteCommands.deleteSite(profile, siteId, options.yes === true, output),
      ),
    );
}
