import { WORKSPACE_OPERATIONS } from '@nix/structure-spec';
import { describe, expect, it } from 'vitest';

import {
  chatCatalog,
  openUiCatalog,
  structureOperations,
  toolNamesChat,
  workspaceTools,
} from './catalog.ts';
import {
  capabilityRules,
  conversationScopeRules,
  instructions,
  noteScopeRules,
} from './instructions.ts';
import { request } from '../testing/testing.ts';

describe('catalog built at run time', () => {
  it('offers one typed function tool per operation', () => {
    const tools = workspaceTools();
    expect(tools).toHaveLength(WORKSPACE_OPERATIONS.length);
    expect(toolNamesChat().size).toBe(WORKSPACE_OPERATIONS.length);
    for (const operation of WORKSPACE_OPERATIONS)
      expect(toolNamesChat().has(`nix_${operation}`)).toBe(true);
    expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
    expect(toolNamesChat().has('nix_workspace')).toBe(false);
  });

  it('hands out fresh schemas each call', () => {
    const first = workspaceTools();
    (first[0] as { name: string }).name = 'changed';
    expect(workspaceTools()[0]?.name).not.toBe('changed');
  });
});

describe('instructions', () => {
  it('name every structure operation in the capability sentence', () => {
    const operations = structureOperations();
    expect(operations.length).toBeGreaterThan(5);
    for (const operation of operations) expect(capabilityRules()).toContain(`nix_${operation}`);
    expect(capabilityRules()).toMatch(/nix_\w+ and nix_\w+;/);
  });

  it('keep the approval, evidence and read-hold boundaries', () => {
    const text = instructions();
    expect(text).toContain('the Nix approval card is the only permission request');
    expect(text).toContain('Review with reads only');
    expect(text).toContain('A read of lock-protected content keeps later writes held');
    expect(text).toContain('nix_replace_section');
    expect(text).toContain('You cannot administer workspaces, replace a whole note body');
    expect(text).toContain('Each user turn has a limit of 20 distinct tool calls');
    expect(text).toContain('call nix_search_note on it');
    expect(text.endsWith(openUiCatalog())).toBe(true);
    expect(text).toContain(`Nix capabilities: ${chatCatalog()}`);
  });

  it('keeps general questions out of workspace reads and respects item types', () => {
    const text = instructions();
    expect(text).toContain('Answer general questions directly without workspace tools.');
    expect(text).toContain('Use nix_read_item if the item type is unknown.');
    expect(text).toContain(
      'Use nix_read_note for notes, artifacts and supported files, never for canvases or sheets.',
    );
    const scope = noteScopeRules(request({ rootItemId: 'x', readOnly: true }));
    expect(scope).toContain('Workspace tools in this conversation are limited to rootItemId');
    expect(scope).toContain('use the tool that supports its item type');
  });

  it('explains enabled pet jobs while preserving direct chat scope and approvals', () => {
    const text = instructions();
    expect(text).toContain('When pet jobs are enabled in the workspace');
    expect(text).toContain("sending an action request in an item's pet dialog");
    expect(text).toContain('A job uses its selected sources and enabled abilities.');
    expect(text).toContain('Each approval covers the reviewed effect.');
    expect(text).toContain(
      'The direct chat restrictions in these instructions apply to chat tool calls.',
    );
    expect(text).toContain('A capability question requests an explanation.');
    expect(text).toContain('Never access host files, shell, network, browser or host tools.');
    expect(noteScopeRules(request({ rootItemId: 'x', readOnly: true }))).toContain(
      'readOnly is on: answer and retrieve only. Do not propose or call a mutation.',
    );
  });

  it('add the note and saved-conversation scopes only when they apply', () => {
    expect(noteScopeRules(request())).toBe('');
    expect(noteScopeRules(request({ rootItemId: 'x', readOnly: true }))).toContain(
      'readOnly is on',
    );
    expect(noteScopeRules(request({ rootItemId: 'x', readOnly: false }))).toContain(
      'readOnly is off',
    );
    expect(conversationScopeRules(request())).toBe('');
    expect(conversationScopeRules(request({ conversationItemId: 'y' }))).toContain(
      'read-only cross-workspace analysis conversation',
    );
  });
});
