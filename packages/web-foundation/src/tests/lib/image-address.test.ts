import { describe, expect, it } from 'vitest';

import { imageAddressSchema, isFetchableImageAddress } from '../../lib/image-address';

describe('the shared image-address policy', () => {
  it.each(['https://images.example.test/plan.png', 'http://images.example.test/plan.png'])(
    'accepts a browser-fetchable image address: %s',
    (value) => {
      expect(isFetchableImageAddress(value)).toBe(true);
    },
  );

  it.each(['', 'relative.png', 'data:image/png;base64,eA==', 'javascript:alert(1)'])(
    'refuses an empty, relative, or executable address: %s',
    (value) => {
      expect(isFetchableImageAddress(value)).toBe(false);
    },
  );

  it('returns the trimmed address at the form boundary', () => {
    expect(imageAddressSchema.parse('  https://images.example.test/plan.png  ')).toBe(
      'https://images.example.test/plan.png',
    );
  });
});
