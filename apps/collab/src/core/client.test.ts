import { describe, expect, it } from 'vitest';

import { createCoreClient } from './client.ts';

describe('Core property snapshots', () => {
  it('preserves formula and rollup definitions in effective and declared archive schemas', async () => {
    const properties = [
      {
        key: 'total',
        label: 'Total',
        type: 'formula',
        options: [],
        required: false,
        expression: '[amount] * 2',
        aggregate: null,
        source: null,
      },
      {
        key: 'amount_sum',
        label: 'Amount sum',
        type: 'rollup',
        options: [],
        required: false,
        expression: null,
        aggregate: 'sum',
        source: 'amount',
      },
      { key: 'name', label: 'Name', type: 'text', options: [], required: false },
    ];
    const schema = { properties, declared: properties.slice(1), inherit: true };
    const client = createCoreClient({
      coreBaseUrl: 'https://core.test',
      fetch: () => Promise.resolve(new Response(JSON.stringify(schema))),
    });

    expect(await client.getSchema('token', 'item')).toEqual(schema);
  });

  it.each(['expression', 'aggregate', 'source'])(
    'refuses malformed computed %s metadata without dropping it',
    async (field) => {
      const property = {
        key: 'name',
        label: 'Name',
        type: 'text',
        options: [],
        required: false,
        [field]: 7,
      };
      const schema = { properties: [property], declared: [property], inherit: true };
      const client = createCoreClient({
        coreBaseUrl: 'https://core.test',
        fetch: () => Promise.resolve(new Response(JSON.stringify(schema))),
      });

      await expect(client.getSchema('token', 'item')).rejects.toThrow(
        'Core returned invalid computed property metadata.',
      );
    },
  );
});

describe('Core view snapshots', () => {
  it('preserves composition, filters and interactive form configuration for archive round trips', async () => {
    const client = createCoreClient({
      coreBaseUrl: 'https://core.test',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              default: 'responses',
              views: [
                {
                  id: 'responses',
                  name: 'Responses',
                  kind: 'list',
                  columns: ['status'],
                  groupBy: null,
                  groupOrder: [],
                  dateProperty: null,
                  sortBy: 'status',
                  sortDescending: true,
                  mode: null,
                  coverProperty: null,
                  endDateProperty: null,
                  cardSize: null,
                  filters: [{ property: 'status', operator: 'equals', value: 'Open' }],
                  companionViewId: 'intake',
                  companionPlacement: 'beside',
                  interactiveForm: null,
                },
                {
                  id: 'intake',
                  name: 'Intake',
                  kind: 'interactive_form',
                  columns: [],
                  interactiveForm: {
                    pages: [
                      {
                        id: 'page-1',
                        title: 'Details',
                        description: 'Tell us more',
                        visibleWhen: [],
                        blocks: [
                          {
                            id: 'question-1',
                            kind: 'field',
                            propertyKey: 'status',
                            text: 'Status',
                            help: null,
                            required: true,
                            identityRole: null,
                            visibleWhen: [],
                          },
                        ],
                      },
                    ],
                    titleMode: 'field',
                    titleFieldBlockId: 'question-1',
                    confirmationTitle: 'Thank you',
                    confirmationMessage: 'Your response was saved.',
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
    });

    const views = await client.getViews('token', 'item');

    expect(views).toMatchObject({
      default: 'responses',
      views: [
        {
          filters: [{ property: 'status', operator: 'equals', value: 'Open' }],
          companionViewId: 'intake',
          companionPlacement: 'beside',
        },
        {
          interactiveForm: {
            pages: [{ blocks: [{ required: true, propertyKey: 'status' }] }],
            confirmationTitle: 'Thank you',
          },
        },
      ],
    });
  });
  it("reads comment threads as export snapshots, keeping an imported comment's original author", async () => {
    const client = createCoreClient({
      coreBaseUrl: 'http://core',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              revision: 3,
              threads: [
                {
                  id: 't1',
                  quote: 'plan',
                  resolvedAt: '2026-10-29T10:00:00Z',
                  comments: [
                    {
                      authorName: 'Importer',
                      importedAuthor: 'Ada',
                      body: 'Why?',
                      createdAt: 'c1',
                    },
                    { authorName: 'Bo', importedAuthor: null, body: 'Because', createdAt: 'c2' },
                  ],
                },
              ],
            }),
            { status: 200 },
          ),
        ),
    });

    expect(await client.listComments('token', 'item')).toEqual([
      {
        id: 't1',
        quote: 'plan',
        resolved: true,
        comments: [
          { author: 'Ada', body: 'Why?', createdAt: 'c1' },
          { author: 'Bo', body: 'Because', createdAt: 'c2' },
        ],
      },
    ]);
  });
});
