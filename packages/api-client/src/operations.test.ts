import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OPERATIONS,
  findOperations,
  isCredentialOperation,
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
    const denied = OPERATIONS.filter(isCredentialOperation).map((op) => op.id);
    expect(denied).toEqual(
      expect.arrayContaining(['CreateAccessToken', 'SavePetProviderKey', 'SavePetSettings']),
    );
    expect(isCredentialOperation(entry('MoveItem'))).toBe(false);
    expect(isCredentialOperation(entry('KeepItem'))).toBe(false);
  });

  it('warns about final, access and public changes, not about trashing', () => {
    expect(operationRisk(entry('PurgeItem'))).toBe('irreversible');
    expect(operationRisk(entry('DeleteItem'))).toBeUndefined();
    expect(operationRisk(entry('RemoveWorkspaceMember'))).toBe('access');
    expect(operationRisk(entry('PublishSite'))).toBe('public');
    expect(operationRisk(entry('GetBookmarks'))).toBeUndefined();
  });

  it('builds the request from the template and refuses anything outside it', () => {
    expect(
      operationRequest(entry('MoveItem'), {
        path: { itemId: 'a/../b' },
        body: { parentId: null, afterId: null },
      }),
    ).toEqual({ method: 'POST', path: '/api/v1/items/a%2F..%2Fb/move', query: {} });
    expect(
      operationRequest(entry('ListItems'), { path: { workspaceId: 'w' }, query: { limit: 5 } }),
    ).toEqual({ method: 'GET', path: '/api/v1/workspaces/w/items', query: { limit: 5 } });
    expect(() => operationRequest(entry('MoveItem'), {})).toThrow(/itemId/);
    expect(() =>
      operationRequest(entry('ListItems'), { path: { workspaceId: 'w' }, query: { evil: 1 } }),
    ).toThrow(/no query parameter/);
    expect(() => operationRequest(entry('GetBookmarks'), { body: { anything: true } })).toThrow(
      /no request body/,
    );
  });
});
