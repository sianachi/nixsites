import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { buildCatalog, buildPetTools, renderCatalog } from '@nix/structure-spec';

import { isRecord } from '../shared/util.ts';

/** One typed nix_<operation> function tool, as `dynamicTools` in `thread/start` needs it. */
export interface DynamicTool {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Built {
  chat: string;
  tools: DynamicTool[];
  names: ReadonlySet<string>;
}

let built: Built | undefined;

/**
 * The chat catalog text, built from @nix/structure-spec at run time: renderCatalog over buildCatalog plus the committed
 * patterns text, trailing whitespace trimmed, one final newline.
 */
function build(): Built {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('@nix/structure-spec/package.json'));
  const patterns = readFileSync(join(root, 'catalog', 'patterns.txt'), 'utf8');
  const chat = `${renderCatalog(buildCatalog(), patterns).trimEnd()}\n`;
  const tools = buildPetTools().map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return { chat, tools, names: new Set(tools.map((tool) => tool.name)) };
}

function catalog(): Built {
  built ??= build();
  return built;
}

export const chatCatalog = (): string => catalog().chat;
export const toolNamesChat = (): ReadonlySet<string> => catalog().names;

/** Cached at the same path the web's prompt snapshot test writes; see openui.txt's header note. */
let openUi: string | undefined;
export function openUiCatalog(): string {
  openUi ??= readFileSync(new URL('./openui.txt', import.meta.url), 'utf8');
  return openUi;
}

/** The typed per-operation tools as fresh objects (callers may mutate their schemas). */
export function workspaceTools(): DynamicTool[] {
  return structuredClone(catalog().tools);
}

/** Strips the "nix_" prefix a typed tool name always carries. */
export function operationFromToolName(tool: string): string {
  return tool.startsWith('nix_') ? tool.slice(4) : tool;
}

/** The "Section: Structure operations" line of the catalog, so the capability sentence cannot drift. */
export function structureOperations(): string[] {
  const marker = 'Section: Structure operations\n';
  const text = chatCatalog();
  const start = text.indexOf(marker);
  if (start === -1) return [];
  const rest = text.slice(start + marker.length);
  const end = rest.indexOf('\n');
  const line = (end === -1 ? rest : rest.slice(0, end)).trim();
  if (line === '') return [];
  return line
    .split(', ')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export function toolSchema(tool: DynamicTool): {
  properties: Record<string, unknown>;
  required: unknown[];
} {
  const properties = tool.inputSchema.properties;
  if (!isRecord(properties)) throw new Error(`${tool.name} has no properties`);
  const required = Array.isArray(tool.inputSchema.required)
    ? (tool.inputSchema.required as unknown[])
    : [];
  return { properties, required };
}
