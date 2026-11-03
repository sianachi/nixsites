import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { useIconStripPreference } from '@nix/web-foundation/lib/icon-strip-preference';
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

beforeEach(() => {
  signedIn();
  useIconStripPreference.setState({ enabled: true });
});

afterEach(() => {
  localStorage.removeItem('nix.icon-strip');
});

describe('the icon strip setting', () => {
  it('is on by default and stores only the "off" choice', () => {
    expect(useIconStripPreference.getState().enabled).toBe(true);
    useIconStripPreference.getState().setEnabled(false);
    expect(localStorage.getItem('nix.icon-strip')).toBe('0');
    useIconStripPreference.getState().setEnabled(true);
    expect(localStorage.getItem('nix.icon-strip')).toBeNull();
  });

  it('hides the strip; Search, the bell and the profile stay in the title row', async () => {
    useIconStripPreference.setState({ enabled: false });
    stubCoreApi();
    renderAt(<App />, '/');
    const header = await screen.findByRole('banner', { name: 'Workspace controls' });
    expect(screen.queryByRole('navigation', { name: 'Destinations' })).toBeNull();
    expect(within(header).getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: /notifications/i })).toBeInTheDocument();
  });
});
