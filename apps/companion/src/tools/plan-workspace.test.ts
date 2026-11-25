import { readFileSync } from 'node:fs';
import { WORKSPACE_OPERATIONS } from '@nix/structure-spec';
import { TOOL_EXAMPLES } from '@nix/structure-spec/testing';
import { describe, expect, it } from 'vitest';
import { flattenToolCall, validateToolArguments } from './flatten.ts';
import { workspacePlanCapabilities } from './plan-workspace.ts';

describe('workspace plan catalog', () => {
  it('offers every current native operation through the existing typed schema', () => {
    const capabilities = workspacePlanCapabilities();
    expect(capabilities.map((entry) => entry.name).sort()).toEqual(
      WORKSPACE_OPERATIONS.map((operation) => `workspace.${operation}`).sort(),
    );
    for (const operation of WORKSPACE_OPERATIONS) {
      const offered = capabilities.find((entry) => entry.name === `workspace.${operation}`);
      expect(offered?.inputSchema).toBeDefined();
      const flat = flattenToolCall(`nix_${operation}`, TOOL_EXAMPLES[operation]);
      expect(flat.reason, operation).toBe('');
      expect(validateToolArguments(flat.flat ?? ''), operation).toBe('');
    }
  });

  it('keeps the fixed Core registry equal to the native operation catalog', () => {
    const source = readFileSync(
      new URL(
        '../../../../backend/src/Nix.Api/Features/PetRuns/PetWorkspaceToolCapability.cs',
        import.meta.url,
      ),
      'utf8',
    );
    const names = [...source.matchAll(/"(workspace\.[a-z_]+)"/g)].map((match) => match[1]);
    expect([...new Set(names)].sort()).toEqual(
      WORKSPACE_OPERATIONS.map((operation) => `workspace.${operation}`).sort(),
    );
  });
});
