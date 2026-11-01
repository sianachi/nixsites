import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../../app';
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { serviceLabel } from '@nix/web-settings/settings/about/about-section';

beforeEach(() => {
  signedIn();
});

const now = new Date().toISOString();

describe('Settings > About', () => {
  it('lists the release each service runs and flags one that differs from Core', async () => {
    stubCoreApi({
      systemVersions: [
        { service: 'api', version: '0.5.0', commit: 'e0fa7e4371083c99', reportedAt: now },
        { service: 'collab', version: '0.5.0', commit: 'e0fa7e4371083c99', reportedAt: now },
        { service: 'worker:import', version: '0.4.0', commit: '31c6ae8adc888b16', reportedAt: now },
      ],
    });
    renderAt(<App />, '/settings?tab=about');

    const section = await screen.findByRole('region', { name: 'About' });
    expect(await within(section).findByText('Core API')).toBeVisible();
    expect(within(section).getByText('Collaboration')).toBeVisible();
    expect(within(section).getByText('Worker (import)')).toBeVisible();
    expect(within(section).getByText('0.4.0')).toBeVisible();
    expect(within(section).getAllByText('Differs from Core')).toHaveLength(1);
  });

  it('names services in words', () => {
    expect(serviceLabel('worker:import,export')).toBe('Worker (import, export)');
    expect(serviceLabel('sites-worker')).toBe('Sites worker');
    expect(serviceLabel('mystery')).toBe('mystery');
  });
});
