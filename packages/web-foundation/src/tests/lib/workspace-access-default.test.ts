import { beforeEach, expect, it } from 'vitest';
import { readWorkspaceAccess, writeWorkspaceAccess } from '../../lib/device-preferences';

beforeEach(() => {
  localStorage.clear();
});

it('offers workspace context by default for a new pet and workspace', () => {
  expect(readWorkspaceAccess('workspace', 'pet')).toBe(true);
});

it('retains an explicit off choice without affecting other workspaces or pets', () => {
  writeWorkspaceAccess('workspace', 'pet', false);
  expect(readWorkspaceAccess('workspace', 'pet')).toBe(false);
  expect(readWorkspaceAccess('other', 'pet')).toBe(true);
  expect(readWorkspaceAccess('workspace', 'other')).toBe(true);
});

it('restores access when the owner turns it on', () => {
  writeWorkspaceAccess('workspace', 'pet', false);
  writeWorkspaceAccess('workspace', 'pet', true);
  expect(readWorkspaceAccess('workspace', 'pet')).toBe(true);
});
