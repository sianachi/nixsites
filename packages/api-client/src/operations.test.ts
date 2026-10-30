import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OPERATIONS,
  findOperations,
  isHumanOnlyOperation,
  operationById,
  operationRequest,
  operationRisk,
  type OperationEntry,
} from './operations.js';

const entry = (id: string): OperationEntry => {
  const found = operationById(id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
};

describe('operation catalog', () => {
  it('holds every /api/v1 operation in the published contract', () => {
    const contract = JSON.parse(
      readFileSync(new URL('../../../backend/openapi/nix-api.json', import.meta.url), 'utf8'),
    ) as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ids = Object.entries(contract.paths)
      .filter(([path]) => path.startsWith('/api/v1/'))
      .flatMap(([, methods]) => Object.values(methods).map((op) => op.operationId))
      .filter((id): id is string => id !== undefined)
      .sort();
    expect(OPERATIONS.map((op) => op.id).sort()).toEqual(ids);
  });

  it('finds the operation a plain request names', () => {
    const top = (query: string) => findOperations(query, 4).map((op) => op.id);
    expect(top('bookmark this note')).toContain('KeepItem');
    expect(top('move to another workspace')[0]).toBe('MoveItem');
    expect(top('purge from trash')).toContain('PurgeItem');
    expect(findOperations('')).toEqual([]);
  });

  it('keeps credentials and the pet itself away from assistants', () => {
    const denied = OPERATIONS.filter(isHumanOnlyOperation).map((op) => op.id);
    expect(denied).toEqual(
      expect.arrayContaining(['CreateAccessToken', 'SavePetProviderKey', 'SavePetSettings']),
    );
    for (const id of [
      'GrantTenantAdmin',
      'GrantSiteOperator',
      'ApproveSitePublish',
      'SendConversation',
      'SavePreferences',
    ])
      expect(isHumanOnlyOperation(entry(id)), id).toBe(true);
    expect(isHumanOnlyOperation(entry('GetPreferences'))).toBe(false);
    expect(isHumanOnlyOperation(entry('MoveItem'))).toBe(false);
    expect(isHumanOnlyOperation(entry('KeepItem'))).toBe(false);
  });

  it('warns about final, access and public changes, not about trashing', () => {
    expect(operationRisk(entry('PurgeItem'))).toBe('irreversible');
    expect(operationRisk(entry('DeleteItem'))).toBeUndefined();
    expect(operationRisk(entry('RemoveWorkspaceMember'))).toBe('access');
    expect(operationRisk(entry('PublishSite'))).toBe('public');
    expect(operationRisk(entry('GetBookmarks'))).toBeUndefined();
    expect(operationRisk(entry('RestoreItem'))).toBeUndefined();
    for (const id of ['CreateAutomation', 'ArchiveWorkspace', 'MoveItem'])
      expect(operationRisk(entry(id)), id).toBe('access');
    expect(operationRisk(entry('UpdateSite'))).toBe('public');
  });

  it('builds the request from the template and refuses anything outside it', () => {
    const id = '01a18c5b-3b64-70bf-8468-b159e5454a52';
    expect(
      operationRequest(entry('MoveItem'), {
        path: { itemId: id },
        body: { parentId: null, afterId: null },
      }),
    ).toEqual({ method: 'POST', path: `/api/v1/items/${id}/move`, query: {} });
    expect(() => operationRequest(entry('MoveItem'), { path: { itemId: 'a/../b' } })).toThrow(
      /not a valid/,
    );
    // ".." would fold DELETE /sites/S/hostnames/.. into DeleteSite.
    expect(() =>
      operationRequest(entry('RemoveSiteHostname'), { path: { siteId: id, hostname: '..' } }),
    ).toThrow(/not a valid/);
    expect(
      operationRequest(entry('ListItems'), { path: { workspaceId: id }, query: { limit: 5 } }),
    ).toEqual({ method: 'GET', path: `/api/v1/workspaces/${id}/items`, query: { limit: 5 } });
    expect(() => operationRequest(entry('MoveItem'), {})).toThrow(/itemId/);
    expect(() =>
      operationRequest(entry('ListItems'), { path: { workspaceId: id }, query: { evil: 1 } }),
    ).toThrow(/no query parameter/);
    expect(() => operationRequest(entry('GetBookmarks'), { body: { anything: true } })).toThrow(
      /no request body/,
    );
  });
});
