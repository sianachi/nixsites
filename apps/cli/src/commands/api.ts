/**
 * `nixctl api`: every Core operation by id, for what no dedicated command covers. The catalog
 * decides the method and path; Core still applies the signed-in person's permissions and scopes.
 */

import { readFile } from 'node:fs/promises';
import {
  callOperation,
  findOperations,
  OPERATIONS,
  operationRisk,
  type OperationCall,
} from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/** Lists operations, or the best matches for a plain-language filter. */
export function listApiOperations(filter: readonly string[], output: OutputOptions): void {
  const entries = filter.length > 0 ? findOperations(filter.join(' '), 20) : OPERATIONS;
  printResult(
    {
      count: entries.length,
      operations: entries.map((entry) => ({
        id: entry.id,
        method: entry.method,
        path: entry.path,
        risk: operationRisk(entry) ?? null,
        summary: entry.summary,
      })),
    },
    output,
  );
}

/** `k=v` pairs into a record; with `typed`, `true`/`false` and numbers keep their type. */
function parsePairs(pairs: readonly string[], flag: string, typed: boolean) {
  const record: Record<string, string | number | boolean> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`${flag} expects key=value, got '${pair}'.`);
    const raw = pair.slice(eq + 1);
    record[pair.slice(0, eq)] =
      typed && (raw === 'true' || raw === 'false')
        ? raw === 'true'
        : typed && raw.trim() !== '' && Number.isFinite(Number(raw))
          ? Number(raw)
          : raw;
  }
  return record;
}

async function parseBody(body: string | undefined): Promise<unknown> {
  if (body === undefined) return undefined;
  const source = body.startsWith('@') ? await readFile(body.slice(1), 'utf8') : body;
  try {
    return JSON.parse(source);
  } catch {
    throw new Error('--body must be valid JSON, or @file naming a file that holds it.');
  }
}

export interface ApiCallOptions {
  readonly param?: readonly string[] | undefined;
  readonly query?: readonly string[] | undefined;
  readonly body?: string | undefined;
}

export async function callApi(
  profileName: string | undefined,
  operationId: string,
  options: ApiCallOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const call: OperationCall = {
    path: parsePairs(options.param ?? [], '--param', false) as Record<string, string>,
    query: parsePairs(options.query ?? [], '--query', true),
    body: await parseBody(options.body),
  };
  const session = await resolveSession(profileName, deps);
  printResult((await callOperation(session.client, operationId, call)) ?? { ok: true }, output);
}
