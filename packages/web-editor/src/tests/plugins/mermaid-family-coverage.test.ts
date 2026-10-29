import mermaid from 'mermaid';
import { beforeAll, describe, expect, it } from 'vitest';

import { MERMAID_FAMILY_FIXTURES } from './fixtures/mermaid-families';

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
});

describe('the installed Mermaid syntax families', () => {
  it.each(MERMAID_FAMILY_FIXTURES)('parses $id as $diagramType', async (fixture) => {
    await expect(mermaid.parse(fixture.source)).resolves.toMatchObject({
      diagramType: fixture.diagramType,
    });
  });

  it('has a distinct fixture for every syntax example and covers all 34 families', () => {
    expect(new Set(MERMAID_FAMILY_FIXTURES.map((fixture) => fixture.id)).size).toBe(
      MERMAID_FAMILY_FIXTURES.length,
    );
    expect(new Set(MERMAID_FAMILY_FIXTURES.map((fixture) => fixture.diagramType)).size).toBe(34);
  });

  it('accounts for every registered family beyond renderer aliases and error sentinels', () => {
    const aliasesAndSentinels = new Set([
      '---',
      'error',
      'flowchart',
      'flowchart-elk',
      'class',
      'state',
    ]);
    const registered = mermaid
      .getRegisteredDiagramsMetadata()
      .map(({ id }) => id)
      .filter((id) => !aliasesAndSentinels.has(id));
    expect(new Set(MERMAID_FAMILY_FIXTURES.map((fixture) => fixture.diagramType))).toEqual(
      new Set(registered),
    );
  });
});
