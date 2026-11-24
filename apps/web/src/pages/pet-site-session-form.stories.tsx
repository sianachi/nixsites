import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AuthOverrideProvider } from '@nix/web-platform/auth/auth-provider';
import type { ReactNode } from 'react';

import { PetSiteSessionForm } from './pet-site-session-form';

export default { title: 'Nix/Companion/Website session' };

function preview(disabled = false): ReactNode {
  return (
    <AuthOverrideProvider
      value={{
        mode: 'local',
        setupRequired: false,
        isConfigured: true,
        accountUrl: null,
        signIn: () => Promise.resolve(),
        signOut: () => Promise.resolve(),
        getAccessToken: () => Promise.resolve(null),
        handleSessionRefusal: () => undefined,
      }}
    >
      <ApiClientProvider>
        <div className="w-full p-3">
          <PetSiteSessionForm
            workspaceId="11111111-1111-4111-8111-111111111111"
            disabled={disabled}
            onRegistered={() => undefined}
          />
        </div>
      </ApiClientProvider>
    </AuthOverrideProvider>
  );
}

export const CookieFields = {
  render: (): ReactNode => preview(),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: 'HTTPS origin' }),
      'https://example.com',
    );
    const first = within(canvas.getByRole('group', { name: 'Session cookie 1' }));
    await userEvent.type(first.getByRole('textbox', { name: 'Name' }), 'session');
    await userEvent.type(first.getByLabelText(/^Value/), 'synthetic-session-value');
    await userEvent.click(canvas.getByRole('button', { name: 'Add cookie' }));
    const second = within(canvas.getByRole('group', { name: 'Session cookie 2' }));
    await userEvent.type(second.getByRole('textbox', { name: 'Name' }), 'account');
    await userEvent.type(second.getByLabelText(/^Value/), 'synthetic-account-value');
    await userEvent.clear(second.getByRole('textbox', { name: 'Path' }));
    await userEvent.type(second.getByRole('textbox', { name: 'Path' }), '/account');
    if (first.getByLabelText(/^Value/).getAttribute('type') !== 'password') {
      throw new Error('Cookie values must stay concealed.');
    }
  },
};

export const Disabled = { render: (): ReactNode => preview(true) };
