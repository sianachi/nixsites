import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../../app';
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

beforeEach(() => {
  signedIn();
});

describe('Settings > MCP', () => {
  it('explains the stdio path and says when the deployment serves no remote endpoint', async () => {
    stubCoreApi({});
    renderAt(<App />, '/settings?tab=mcp');
    const section = await screen.findByRole('region', { name: 'MCP' });
    expect(within(section).getByText(/does not serve MCP over the network/)).toBeVisible();
    expect(within(section).getByText(/"command": "nixctl"/)).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Disable remote access' })).toBeDisabled();
  });

  it('shows the advertised endpoint and mints a prefixed token for it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ mcpUrl: 'https://nix.example.test/mcp' });
    renderAt(<App />, '/settings?tab=mcp');
    const section = await screen.findByRole('region', { name: 'MCP' });
    // The endpoint comes from its own request and can render after the section does.
    expect(
      await within(section).findByText(
        /claude mcp add --transport http nix https:\/\/nix.example.test\/mcp/,
      ),
    ).toBeVisible();

    await user.click(within(section).getByRole('button', { name: 'Create MCP token' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'laptop');
    await user.click(within(dialog).getByRole('checkbox', { name: /read items/i }));
    await user.click(within(dialog).getByRole('radio', { name: '365 days' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create the token' }));
    expect(await within(dialog).findByText(/mcp:laptop was created/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: /done/i }));

    const list = await within(section).findByRole('list', { name: 'MCP tokens' });
    expect(within(list).getByText('mcp:laptop')).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Disable remote access' })).toBeEnabled();
  });
});
