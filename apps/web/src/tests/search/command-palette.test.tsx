import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Keyboard, NotebookPen } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { CommandPalette } from '../../search/command-palette';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { signedIn } from '@nix/web-foundation/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

const NOTE = item({ id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e', title: 'Acquisition memo' });

function PaletteHarness({ run }: { readonly run: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <AuthProvider>
      <ApiClientProvider>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          Search
        </button>
        <CommandPalette
          open={open}
          commands={[
            {
              id: 'capture',
              label: 'Capture to today’s note',
              hint: 'Add text without leaving what you have open',
              icon: NotebookPen,
              keywords: ['capture'],
              run: () => undefined,
            },
            {
              id: 'shortcuts',
              label: 'Keyboard shortcuts',
              icon: Keyboard,
              keywords: ['shortcuts'],
              run,
            },
          ]}
          onSelectItem={() => undefined}
          onClose={() => {
            setOpen(false);
          }}
        />
      </ApiClientProvider>
    </AuthProvider>
  );
}

beforeEach(() => {
  signedIn();
});

for (const wide of [true, false]) {
  describe(wide ? 'desktop palette' : 'mobile palette', () => {
    it('filters commands without asking Core to search items, then resumes item search', async () => {
      stubViewport(wide);
      stubCoreApi({ items: [NOTE] });
      const user = userEvent.setup();
      render(<PaletteHarness run={() => undefined} />);
      await user.click(screen.getByRole('button', { name: 'Search' }));
      const dialog = await screen.findByRole('dialog', { name: 'Search and commands' });
      const input = within(dialog).getByRole('combobox');
      expect(input).toHaveFocus();
      expect(
        within(dialog).getByRole('option', { name: /Capture to today’s note/ }),
      ).toHaveAccessibleName(
        wide
          ? /Capture to today’s note.*Add text without leaving what you have open/
          : 'Capture to today’s note',
      );
      expect(input).toHaveAccessibleDescription(/Type > for commands only/);

      await user.type(input, '> shortcuts');
      expect(
        within(dialog).getByRole('option', { name: /Keyboard shortcuts/ }),
      ).toBeInTheDocument();
      expect(within(dialog).queryByText('Searching…')).not.toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) =>
            (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes(
              '/api/v1/search',
            ),
          ),
      ).toBe(false);

      await user.clear(input);
      await user.type(input, 'acquisition');
      expect(
        await within(dialog).findByRole('option', { name: 'Acquisition memo' }),
      ).toBeInTheDocument();
      await user.clear(input);
      await user.type(input, '> acquisition');
      expect(
        within(dialog).queryByRole('option', { name: 'Acquisition memo' }),
      ).not.toBeInTheDocument();
      expect(within(dialog).getByText('No commands match “acquisition”.')).toBeInTheDocument();
    });

    it('runs the filtered command with arrow keys and Enter and closes the palette', async () => {
      stubViewport(wide);
      stubCoreApi({ items: [NOTE] });
      const user = userEvent.setup();
      const run = vi.fn();
      render(<PaletteHarness run={run} />);
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await user.type(await screen.findByRole('combobox'), '> shortcuts');
      await user.keyboard('{ArrowDown}{Enter}');
      expect(run).toHaveBeenCalledOnce();
      expect(screen.queryByRole('dialog', { name: 'Search and commands' })).not.toBeInTheDocument();
    });
  });
}

it('restores the invoking control after dismissal and clears the command filter on reopening', async () => {
  stubCoreApi({ items: [NOTE] });
  const user = userEvent.setup();
  render(<PaletteHarness run={() => undefined} />);
  const search = screen.getByRole('button', { name: 'Search' });
  await user.click(search);
  await user.type(screen.getByRole('combobox'), '> shortcuts');
  await user.click(screen.getByRole('button', { name: 'Close search' }));
  expect(search).toHaveFocus();
  await user.click(search);
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue(''));
});
