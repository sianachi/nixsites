/**
 * `nixctl schema get|set` and `nixctl props set`: the two things an item declares over its subtree.
 *
 * The *schema* is what an item says its children carry (a board's columns, a calendar's date field);
 * the *properties* are the values on the item itself that those views read. A stress run that wants
 * a board with cards, a calendar with dated entries or a rollup with numbers to sum needs to write
 * both from a script, which is what these three commands are for.
 *
 * `props set` takes `key=value` pairs and parses each value as JSON when it parses (so `count=5` is
 * the number 5 and `archived=null` clears the key) and otherwise as a plain string (so `status=done`
 * and `due=2026-01-01` are strings). This mirrors the merge the endpoint performs: a key given is
 * set, a key set to `null` is cleared, a key left out is untouched.
 */

import { readFile } from 'node:fs/promises';
import {
  items,
  structure,
  propertyDefinitionSchema,
  type PropertyDefinition,
} from '@nix/api-client';
import { readStructure, type ReadStructureResult } from '@nix/companion';
// The light subpath: `parseScalar` is the shared value rule for `props set` and import's front
// matter, and pulling it must not load the Markdown mapping into every command.
import { parseScalar } from '@nix/markdown/front-matter';
import type { Session } from '../session.ts';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';
import { portsFor } from './blueprint.ts';

/** Reads an item's effective property schema and prints what it declares, inherits and resolves to. */
export async function getSchema(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const answer = await session.client.query(structure.effectiveSchema(itemId));

  printResult(
    {
      properties: answer.properties,
      declared: answer.declared,
      inherit: answer.inherit,
      count: answer.properties.length,
    },
    output,
  );
}

/** Reads the same bounded structure outline that `read_structure` exposes to the pet. */
export async function readStructureOutline(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await readStructureForSession(session, itemId), output);
}

/** Executes the shared outline reader with a previously resolved authenticated session. */
export async function readStructureForSession(
  session: Session,
  itemId: string,
): Promise<ReadStructureResult> {
  const item = await session.client.query(items.itemById(itemId), { forceRefresh: true });
  return readStructure(portsFor(session), item.workspaceId, itemId, AbortSignal.timeout(90_000));
}

/** Replaces an item's declared schema from a JSON file `{ "properties": [...], "inherit": bool }`. */
export async function setSchema(
  profileName: string | undefined,
  itemId: string,
  file: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const input = parseSchemaFile(await readFile(file, 'utf8'), file);

  const session = await resolveSession(profileName, deps);
  const answer = await session.client.execute(
    structure.setItemSchema(itemId, { properties: input.properties, inherit: input.inherit }),
  );

  printResult(
    {
      id: itemId,
      declared: answer.declared,
      inherit: answer.inherit,
      count: answer.properties.length,
    },
    output,
  );
}

/** Merges `key=value` property values onto an item; a `null` value clears a key. */
export async function setProps(
  profileName: string | undefined,
  itemId: string,
  pairs: readonly string[],
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const properties = parseAssignments(pairs);

  const session = await resolveSession(profileName, deps);
  const item = await session.client.execute(structure.setItemProperties(itemId, properties));

  printResult({ id: item.id, title: item.title, set: Object.keys(properties) }, output);
}

/**
 * Turns `key=value` arguments into a property bag, parsing each value as JSON when it parses and as a
 * plain string otherwise.
 *
 * @throws When a pair has no `=`, so a typo fails at the prompt rather than silently setting nothing.
 */
export function parseAssignments(pairs: readonly string[]): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Expected key=value, got '${pair}'. A key is required before the '='.`);
    }
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    bag[key] = parseScalar(raw);
  }
  return bag;
}

interface SchemaFile {
  readonly properties: PropertyDefinition[];
  readonly inherit: boolean;
}

/**
 * Parses and shape-checks the schema file, so a malformed one fails naming the field rather than
 * reaching Core as an opaque 422. Each property is parsed against the same schema the client parses
 * responses with, so a missing `key` or `type` is caught here; whether the property *makes sense*
 * for this subtree is still Core's to judge.
 */
function parseSchemaFile(text: string, path: string): SchemaFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} must be a JSON object with 'properties' and 'inherit'.`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.inherit !== 'boolean') {
    throw new Error(`${path} must have an 'inherit' boolean.`);
  }
  const properties = propertyDefinitionSchema.array().safeParse(record.properties);
  if (!properties.success) {
    throw new Error(
      `${path}: 'properties' must be an array of { key, label, type, options, required } - ` +
        `plus 'expression' on a formula property.`,
    );
  }
  return { properties: properties.data, inherit: record.inherit };
}
