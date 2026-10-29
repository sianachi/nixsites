import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SitePublishDialog } from '../../sites/site-publish-dialog';

describe('the first-publish dialog', () => {
  it('names the address and refuses to publish until the disclosure is acknowledged', async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn(() => Promise.resolve(null));
    const onClose = vi.fn();
    render(
      <SitePublishDialog
        open
        url="https://garden.nixsites.com/"
        republishMode="manual"
        onPublish={onPublish}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Anyone on the internet can find and read this item and everything inside it at https://garden.nixsites.com/. The site lists its pages for search engines.',
    );
    expect(screen.getByText(/later edits are not public until you publish again/i)).toBeVisible();
    expect(screen.getByText(/search engines and web archives may keep copies/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /^publish$/i }));
    expect(onPublish).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /i understand/i }));
    await user.click(screen.getByRole('button', { name: /^publish$/i }));

    expect(onPublish).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open and says why when Core refuses', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SitePublishDialog
        open
        url={null}
        republishMode="auto"
        onPublish={() => Promise.resolve('A build is already under way.')}
        onClose={onClose}
      />,
    );

    expect(screen.getByText(/automatic publishing is on/i)).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: /i understand/i }));
    await user.click(screen.getByRole('button', { name: /^publish$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already under way/i);
    expect(onClose).not.toHaveBeenCalled();
  });
});
