import { describe, expect, it } from 'vitest';
import { publicLinkSchema } from '../schemas/attachments.js';
import { createPublicLink, listAttachments, setVersionState } from './attachments.js';

const ID = '018f0000-0000-7000-8000-000000000001';

describe('attachments resource', () => {
  it('parses a public link as Core returns it, withheld files included', () => {
    const link = publicLinkSchema.parse({
      url: 'https://links.example.com/p/abc',
      itemId: ID,
      versionId: null,
      versionState: null,
      createdBy: ID,
      createdAt: '2026-09-01T09:00:00+00:00',
      withheldFiles: [{ fileItemId: ID, name: 'draft.docx' }],
    });
    expect(link.withheldFiles).toEqual([{ fileItemId: ID, name: 'draft.docx' }]);
  });

  it('refreshes the attachments list after every change that alters a row', () => {
    for (const endpoint of [setVersionState(ID, ID, 'approved'), createPublicLink(ID)])
      expect(endpoint.invalidates).toContainEqual(['attachments']);
    expect(listAttachments(ID).cacheKey?.[0]).toBe('attachments');
  });
});
