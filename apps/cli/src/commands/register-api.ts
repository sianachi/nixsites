import type { Command } from 'commander';
import { callApi, listApiOperations, type ApiCallOptions } from './api.ts';
import { type Act } from './shared.ts';

export function registerApiCommands(program: Command, act: Act): void {
  const api = program
    .command('api')
    .description('Any Core operation by id, for what no dedicated command covers.');

  api
    .command('list [filter...]')
    .description('List operations, or the best matches for a few words.')
    .action((filter: string[], _options: unknown, command: Command) =>
      act(command, (_profile, output) => {
        listApiOperations(filter, output);
        return Promise.resolve();
      }),
    );

  const collect = (value: string, previous: string[] = []) => [...previous, value];
  api
    .command('call <operationId>')
    .description('Run an operation found with `api list`.')
    .option('--param <key=value>', 'a path parameter (repeatable)', collect)
    .option('--query <key=value>', 'a query parameter (repeatable)', collect)
    .option('--body <json|@file>', 'the JSON request body, or @file holding it')
    .action((operationId: string, options: ApiCallOptions, command: Command) =>
      act(command, (profile, output) => callApi(profile, operationId, options, output)),
    );
}
