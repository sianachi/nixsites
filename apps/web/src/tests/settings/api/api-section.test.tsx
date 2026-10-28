import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../../app';
import { apiBase } from '@nix/web-settings/settings/api/api-section';
import { stubCoreApi } from '../../api-stub';
import { renderAt, signedIn } from '../../render-with-router';

describe('apiBase', () => {
  it('sends the local web app to Core for the token exchange', () => {
    expect(apiBase('http://localhost:5173')).toEqual({
      base: 'http://localhost:5014',
      localDev: true,
    });
    expect(apiBase('https://nixsites.com')).toEqual({
      base: 'https://nixsites.com',
      localDev: false,
    });
  });
});

describe('Settings > API', () => {
  beforeEach(() => {
    signedIn();
    stubCoreApi();
  });

  it('shows the token exchange and a User-Agent', async () => {
    renderAt(<App />, '/settings?tab=api');
    const section = await screen.findByRole('region', { name: 'API' });
    const example = within(section).getByText(/curl -sS/);
    expect(example).toHaveTextContent('/public/v1/auth/token');
    expect(example).toHaveTextContent('nix-api-example/1.0');
    expect(example).toBeVisible();
    expect(within(section).getByText(/default Python and urllib user agents/)).toBeVisible();
    expect(within(section).getByRole('link', { name: 'Access tokens' })).toBeVisible();
    expect(within(section).getByRole('link', { name: 'Nix documentation' })).toHaveAttribute(
      'href',
      'https://nix.nixsites.com',
    );
  });
});
