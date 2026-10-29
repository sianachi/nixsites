import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_STATE_PREVIEW,
  parseStatePreview,
  statePreviewSearch,
} from '../../routing/url-state';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reading state out of the URL', () => {
  it('accepts every value the schema declares', () => {
    expect(parseStatePreview('loading')).toBe('loading');
    expect(parseStatePreview('partial')).toBe('partial');
  });

  it('uses the documented default when the parameter is absent', () => {
    expect(parseStatePreview(null)).toBe(DEFAULT_STATE_PREVIEW);
  });

  it('reports an unrecognised value instead of failing the whole view', () => {
    expect(parseStatePreview('sideways')).toBe(DEFAULT_STATE_PREVIEW);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('builds a search string a link can navigate to', () => {
    expect(statePreviewSearch('error')).toBe('?state=error');
  });
});
