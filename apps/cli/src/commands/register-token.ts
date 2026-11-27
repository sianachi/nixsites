import type { Command } from 'commander';
import { createToken, rotateToken } from './token.ts';
import { type Act } from './shared.ts';

export function registerTokenCommands(program: Command, act: Act): void {
  const token = program.command('token').description('Your personal access tokens.');

  token
    .command('create <name>')
    .description(
      'Mint a token. The secret is shown once. Needs a browser sign-in. pets:send lets it address your pets (with write, and the workspace setting).',
    )
    .requiredOption('--scopes <list>', 'comma-separated: read, write, admin, pets:send')
    .requiredOption('--days <n>', 'expiry in days, 1 to 365')
    .action((name: string, options: { scopes: string; days: string }, command: Command) =>
      act(command, (profile, output) => createToken(profile, name, options, output)),
    );

  token
    .command('rotate <id>')
    .description(
      'Issue a new secret for a live token (the old one stops working) and update local profiles that used it. Needs a browser sign-in.',
    )
    .action((id: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => rotateToken(profile, id, output)),
    );
}
