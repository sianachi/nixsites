import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  navigationProblem,
  SiteDatedCollections,
  SiteSettingsForm,
} from '../../sites/site-settings-form';
import { ROOT_ID, site } from './site-fixtures';

describe('the site settings form', () => {
  it('names the navigation line that has no path and saves nothing', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve(null));
    render(<SiteSettingsForm site={site()} onSave={onSave} />);

    await user.type(
      screen.getByRole('textbox', { name: /top navigation/i }),
      'Home /{Enter}Guide guide',
    );
    await user.click(screen.getByRole('button', { name: /save settings/i }));

    expect(screen.getByText('Line 2 needs a path starting with /.')).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('confirms before turning on automatic publishing', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve(null));
    render(<SiteSettingsForm site={site()} onSave={onSave} />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: /publish changes/i }),
      'Automatically after edits',
    );
    expect(screen.getByText(/every saved edit .* goes public automatically/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    expect(onSave).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog', { name: /publish every edit automatically/i });
    await user.click(within(dialog).getByRole('button', { name: /publish automatically/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ republishMode: 'auto' }));
  });

  it('saves the search engine toggle and the author with the rest of the settings', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve(null));
    render(<SiteSettingsForm site={site()} onSave={onSave} />);

    const hide = screen.getByRole('checkbox', { name: /hide from search engines/i });
    expect(hide).not.toBeChecked();
    await user.click(hide);
    await user.type(screen.getByRole('textbox', { name: /^author/i }), '  Ada Writer ');
    await user.click(screen.getByRole('button', { name: /save settings/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ noindex: true, author: 'Ada Writer' }) as unknown,
      }),
    );
  });

  it('saves the typeface, heading mark and spacing with the rest of the settings', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve(null));
    render(<SiteSettingsForm site={site()} onSave={onSave} />);

    await user.selectOptions(screen.getByRole('combobox', { name: /^typeface/i }), 'serif');
    await user.selectOptions(screen.getByRole('combobox', { name: /^heading mark/i }), 'diamond');
    await user.selectOptions(screen.getByRole('combobox', { name: /^spacing/i }), 'airy');
    await user.click(screen.getByRole('button', { name: /save settings/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          typeface: 'serif',
          headingMark: 'diamond',
          spacing: 'airy',
        }) as unknown,
      }),
    );
  });

  it('checks navigation lines', () => {
    expect(navigationProblem('Home /\n\nGuide /guide/')).toBeNull();
    expect(navigationProblem('Home /\nAbout')).toBe(
      'Line 2 needs a label, a space, then a path starting with /.',
    );
  });
});

describe('dated collections', () => {
  const collection = 'c6666666-6666-4666-8666-666666666666';

  it('lists saved collections by title and field label', async () => {
    render(
      <SiteDatedCollections
        site={site({
          datedCollections: [
            {
              itemId: collection,
              dateProperty: 'published_on',
              tagsProperty: null,
              coverProperty: null,
              summaryProperty: null,
            },
          ],
        })}
        onSave={() => Promise.resolve(null)}
        listChildren={() =>
          Promise.resolve([{ id: collection, title: 'Posts', hasChildren: true }])
        }
        listProperties={() =>
          Promise.resolve([{ key: 'published_on', label: 'Published', type: 'date' }])
        }
      />,
    );

    expect(await screen.findByText('Posts, dated by Published')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove Posts' })).toBeVisible();
  });

  it('says the fields could not be loaded, rather than that there is no date field', async () => {
    const user = userEvent.setup();
    const listProperties = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([{ key: 'date', label: 'Date', type: 'date' }]);
    render(
      <SiteDatedCollections
        site={site()}
        onSave={() => Promise.resolve(null)}
        listChildren={() => Promise.resolve([])}
        listProperties={listProperties}
      />,
    );

    await user.click(screen.getByRole('button', { name: /add a dated collection/i }));
    await user.selectOptions(await screen.findByRole('combobox', { name: /collection/i }), ROOT_ID);
    expect(await screen.findByRole('alert')).toHaveTextContent(/fields could not be loaded/i);
    expect(screen.queryByText(/no date field/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByRole('combobox', { name: /^date/i })).toBeVisible();
  });
});
