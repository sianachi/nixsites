import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPERATIONS, isHumanOnlyOperation } from './operations.js';
import { petCapability, petCapabilityIds } from './pet-capabilities.js';

describe('pet capability coverage', () => {
  it('accounts for every generated operation with its published request target', () => {
    const expected = new Set(OPERATIONS.map(({ id }) => id));
    expect(new Set(petCapabilityIds().filter((id) => !id.includes('.')))).toEqual(expected);
    for (const operation of OPERATIONS) {
      const entry = petCapability(operation.id);
      expect(entry, operation.id).toMatchObject({
        method: operation.method,
        path: operation.path,
      });
      if (isHumanOnlyOperation(operation)) expect(entry?.mode, operation.id).toBe('human');
    }
  });

  it('classifies native editing separately from the workflows that can apply it', () => {
    const toolbar = readFileSync(
      new URL('../../web-editor/src/editor/toolbar.tsx', import.meta.url),
      'utf8',
    );
    const noteControls = [...toolbar.matchAll(/id: '([^']+)'/g)].map(([, id]) => id ?? '');
    expect(noteControls.length).toBeGreaterThan(0);
    for (const id of noteControls) {
      expect(petCapability(`note.${id}`), id).toMatchObject({ editor: 'note', mode: 'review' });
    }
    expect(petCapability('note.replace')).toMatchObject({ executor: 'ReplaceItemBody' });
    expect(petCapability('note.accept-suggestion')?.executor).toBeUndefined();
    expect(petCapability('canvas.arrow')).toMatchObject({ executor: 'canvas.edit' });
    expect(petCapability('sheet.formula')).toMatchObject({ executor: 'sheet.edit' });
  });

  it('keeps approvals, security and a public result outside unattended routines', () => {
    expect(petCapability('UpdateItem')?.mode).toBe('routine');
    expect(petCapability('UpdateTenantSettings')?.mode).toBe('human');
    expect(petCapability('CreateAccessToken')?.mode).toBe('human');
    expect(petCapability('PurgeItem')?.mode).toBe('human');
    expect(petCapability('PublishSite')?.mode).toBe('review');
    expect(petCapability('PublishSite')?.executor).toBeUndefined();
    expect(petCapability('canvas.edit')?.mode).toBe('review');
    expect(petCapability('sheet.undo')?.mode).toBe('review');
    expect(petCapability('not_registered')).toBeUndefined();
    expect(petCapability('__proto__')).toBeUndefined();
  });

  it('keeps plan, sharing and delegation operations outside model execution', () => {
    const ownerOperations = OPERATIONS.filter((operation) =>
      /^\/api\/v1\/workspaces\/[^/]+\/(pet-plans|pet-sharing)(\/|$)/.test(operation.path),
    );
    expect(ownerOperations.length).toBeGreaterThan(0);
    for (const operation of ownerOperations) {
      expect(isHumanOnlyOperation(operation), operation.id).toBe(true);
      expect(petCapability(operation.id)?.mode, operation.id).toBe('human');
      expect(petCapability(operation.id)?.executor, operation.id).toBeUndefined();
    }
  });
});
