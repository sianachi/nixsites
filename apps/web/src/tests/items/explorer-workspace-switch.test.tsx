import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';

import { App } from '../../app';
import { STUB_WORKSPACE, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

beforeEach(() => {
  signedIn();
});

it('switches workspace from the workspace name in the title row', async () => {
  const user = userEvent.setup();
  stubCoreApi();
  renderAt(<App />, '/');
  const header = await screen.findByRole('banner', { name: 'Workspace controls' });
  await user.click(await within(header).findByRole('button', { name: STUB_WORKSPACE.name }));
  // The same workspace entries as the profile menu: the current one ticked, then the way to more.
  expect(await screen.findByRole('menuitemradio', { name: STUB_WORKSPACE.name })).toBeChecked();
  expect(screen.getByText('All workspaces…')).toBeVisible();
  expect(screen.getByText('New workspace')).toBeVisible();
});
