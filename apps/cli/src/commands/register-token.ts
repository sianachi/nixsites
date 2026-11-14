import type { Command } from 'commander';
import { rotateToken } from './token.ts';
import { type Act } from './shared.ts';

export function registerTokenCommands(program: Command, act: Act): void {
  const token = program.command('token').description('Your personal access tokens.');

  token
    .command('rotate <id>')
    .description(
      'Issue a new secret for a live token (the old one stops working) and update local profiles that used it. Needs a browser sign-in.',
    )
    .action((id: string, _options: unknown, command: Command) =>
      act(command, (profile, output) => rotateToken(profile, id, output)),
    );
}
