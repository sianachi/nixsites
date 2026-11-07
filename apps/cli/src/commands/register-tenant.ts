import type { Command } from 'commander';
import { getTenantSettings, setTenantSettings } from './tenant-settings.ts';
import { type Act } from './shared.ts';

export function registerTenantCommands(program: Command, act: Act): void {
  const tenant = program
    .command('tenant')
    .description('Organization-wide settings (administrators).');
  const settings = tenant
    .command('settings')
    .description('Whether remote MCP and public links are on for your organization.');

  settings
    .command('get')
    .description('Print the switches and whether this deployment offers each feature.')
    .action((_options: unknown, command: Command) =>
      act(command, (profile, output) => getTenantSettings(profile, output)),
    );

  settings
    .command('set')
    .description('Turn remote MCP or public links on or off; a field you leave out is unchanged.')
    .option('--mcp <state>', 'on or off')
    .option('--public-links <state>', 'on or off')
    .action((options: { mcp?: string; publicLinks?: string }, command: Command) =>
      act(command, (profile, output) => setTenantSettings(profile, options, output)),
    );
}
