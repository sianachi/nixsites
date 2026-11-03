import { describe, expect, it } from 'vitest';

import { DEMO_WORKSPACE, createDemoFetch } from '../../demo/demo-core';

/** Today as the caller's YYYY-MM-DD, which a smart list read sends. */
function today(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

describe("the demo's smart lists", () => {
  it('apply their filters, through the same engine the app uses offline', async () => {
    const demo = createDemoFetch();
    const created = await demo(`/api/v1/workspaces/${DEMO_WORKSPACE}/structured-items`, {
      method: 'POST',
      body: JSON.stringify({
        parentId: null,
        title: 'Next 7 days',
        type: 'note',
        views: {
          views: [
            {
              id: 'results',
              kind: 'query',
              label: 'Results',
              filters: [{ property: 'due_date', operator: 'within-next', value: '7' }],
            },
          ],
          default: 'results',
        },
      }),
    });
    expect(created.status).toBe(201);
    const {
      item: { id },
    } = (await created.json()) as { item: { id: string } };

    const read = await demo(`/api/v1/items/${id}/query?view=results&today=${today()}`);
    expect(read.status).toBe(200);
    const { results } = (await read.json()) as { results: { title: string }[] };
    // Only the sample task due today is within the next week; the rest are past or later.
    expect(results.map((row) => row.title)).toEqual(['Pricing page']);
  });
});
