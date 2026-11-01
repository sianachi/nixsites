import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { SiteExclusionsPicker } from '../../sites/site-exclusions';
import type { ChildPage } from '../../sites/use-item-site';

const child = (n: number) => ({
  id: `id-${String(n)}`,
  title: `Page ${String(n)}`,
  hasChildren: false,
});

describe('the exclusions picker', () => {
  it('loads the next page of a level on request, then stops offering more', async () => {
    const user = userEvent.setup();
    const second: ChildPage = { items: [child(2)], loadMore: null };
    const first: ChildPage = { items: [child(1)], loadMore: () => Promise.resolve(second) };
    render(
      <SiteExclusionsPicker
        open
        rootItemId="root"
        rootTitle="Site"
        excluded={[]}
        listChildren={() => Promise.resolve(first)}
        onSave={() => Promise.resolve(null)}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByLabelText('Leave out Page 1')).toBeVisible();
    expect(screen.queryByLabelText('Leave out Page 2')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load more items' }));
    expect(await screen.findByLabelText('Leave out Page 2')).toBeVisible();
    expect(screen.getByLabelText('Leave out Page 1')).toBeVisible();
    expect(screen.queryByRole('button', { name: /load more items/i })).toBeNull();
  });
});
