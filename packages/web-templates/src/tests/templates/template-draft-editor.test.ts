import { describe, expect, it } from 'vitest';

import { templateDraftDocumentPath } from '../../templates/draft/template-draft-editor';

describe('the template draft body route', () => {
  it('addresses the provisioning body by template, operation, and portable source item', () => {
    expect(
      templateDraftDocumentPath(
        'a1111111-1111-4111-8111-111111111111',
        'a2222222-2222-4222-8222-222222222222',
        'a3333333-3333-4333-8333-333333333333',
      ),
    ).toBe(
      '/collab/templates/a1111111-1111-4111-8111-111111111111/drafts/a2222222-2222-4222-8222-222222222222/items/a3333333-3333-4333-8333-333333333333/ws',
    );
  });
});
