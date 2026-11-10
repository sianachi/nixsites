import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { petSessionFor } from './commands/pets.ts';
import { resolveSession } from './commands/shared.ts';
import { toFailure } from './output.ts';
import type { Session } from './session.ts';
import type { WorkspaceMcpOptions } from './mcp.ts';

/** What every `register<Group>Tools` receives: the lazily resolved session and the server options. */
export interface McpToolDeps {
  readonly session: () => Promise<Session>;
  readonly options: WorkspaceMcpOptions;
}

export const identifier = z.uuid();
export const workspaceRole = z.enum(['owner', 'editor', 'commenter', 'viewer']);
export const pageInput = {
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
};

export const jsonObjectInput = z.record(z.string(), z.unknown());
/** Rule members Core validates; carried as JSON so the grammar lives once, in Core. */
export const ruleDocumentInput = {
  trigger: jsonObjectInput.optional(),
  conditions: z.array(jsonObjectInput).max(5).optional(),
  actions: z.array(jsonObjectInput).min(1).max(5).optional(),
};
export const RULE_GRAMMAR =
  'trigger: {type:"schedule",freq:"daily"|"weekly"|"monthly",interval,time:"HH:mm",weekdays?:["mo".."su"],timeZone?,startDate?} ' +
  '| {type:"date_arrives",key,offsetMinutes?,time?} | {type:"property_changed",key,from?:{value},to?:{value}}. ' +
  'conditions (<=5, on the triggering item): {key,op:"equals"|"not_equals"|"is_empty"|"is_not_empty",value?}. ' +
  'actions (1-5): {type:"notify",title,body?} | {type:"set_property",target:"triggering_item"|{itemId},key,value} ' +
  '| {type:"create_item",parent:"triggering_item"|"scope"|{itemId},itemType,title,properties?}. ' +
  'Titles may use {date} and {item.title}.';

/** Adapts {@link petSessionFor} (shared with the CLI's `petCommand`/`petToolRun`) to this
 * server's per-call `apiUrl` and its own `resolve` test seam, so `pet_runtime` and
 * `pet_tool_run` reach Core (and Collab) with the same interactive-session-first rule the CLI
 * uses: browser-approved profiles renew access tokens automatically. An `NIX_SESSION_TOKEN`
 * paired with `apiUrl` remains an explicit stdio override. HTTP always uses its request resolver. */
export async function petSessionForMcp(
  apiUrl: string | undefined,
  options: WorkspaceMcpOptions,
): Promise<Session> {
  if (options.transport === 'http') {
    return (options.resolve ?? resolveSession)(options.profileName, options.sessionDeps ?? {});
  }
  return petSessionFor(
    apiUrl,
    options.profileName,
    options.sessionDeps ?? {},
    options.resolve ?? resolveSession,
  );
}

export async function toolResult(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await action();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          // Core's own words (the problem detail, not only its title), plus how to fix a
          // token-scope refusal - the same text the CLI prints.
          text: error instanceof Error ? toFailure(error).message : 'The Nix operation failed.',
        },
      ],
    };
  }
}
