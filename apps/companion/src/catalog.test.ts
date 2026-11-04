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
import { request } from './testing.ts';

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
