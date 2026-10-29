import { createNixClient, type NixClient } from '@nix/api-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SMART_LISTS,
  applySmartList,
  findSmartList,
  smartListView,
  type SmartListPreset,
} from '../../../query/smart-lists';

function client(): NixClient {
  return createNixClient({
    baseUrl: globalThis.location.origin,
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The preset at a position, checked - so a reordered registry fails here by name. */
function presetAt(index: number): SmartListPreset {
  const preset = SMART_LISTS[index];
  if (preset === undefined) {
    throw new Error(`No smart-list preset at position ${String(index)}.`);
  }
  return preset;
}

/**
 * The shipped smart-list presets: what each one filters on, and what applying one stores. The
 * keys are goal 3.1's reserved task-semantic keys (ADR-0042), not workspace conventions - these
 * tests pin the rules by key/operator/value so a future rename of a reserved key fails here
 * rather than silently shipping a preset that matches nothing.
 */

describe('the presets', () => {
  it('offers Today, Next 7 days, Overdue and Assigned to me', () => {
    expect(SMART_LISTS.map((preset) => preset.id)).toEqual([
      'today',
      'next-seven-days',
      'overdue',
      'assigned-to-me',
    ]);
  });

  it('spells Today as due_date on today', () => {
    expect(findSmartList('today')?.filters).toEqual([
      { property: 'due_date', operator: 'on', value: 'today' },
    ]);
  });

  it('spells Next 7 days as due_date within the next 7 days', () => {
    expect(findSmartList('next-seven-days')?.filters).toEqual([
      { property: 'due_date', operator: 'within-next', value: '7' },
    ]);
  });

  it('spells Overdue as due_date before today AND completion not-equals true, with absence counting as not done', () => {
    expect(findSmartList('overdue')?.filters).toEqual([
      { property: 'due_date', operator: 'before', value: 'today' },
      { property: 'completion', operator: 'not-equals', value: 'true' },
    ]);
  });

  it('spells Assigned to me as assignee equals the literal token me, never a resolved identifier', () => {
    const filters = findSmartList('assigned-to-me')?.filters;

    expect(filters).toEqual([{ property: 'assignee', operator: 'equals', value: 'me' }]);
    // The server resolves 'me' to the calling principal; a UUID or any other identifier here
    // would bake in whoever applied the preset rather than the person viewing the list.
    expect(filters?.[0]?.value).toBe('me');
  });

  it('stores one query view that opens by default', () => {
    const view = smartListView(presetAt(0));

    expect(view.kind).toBe('query');
    expect(view.id).toBe('query');
    expect(view.filters).toEqual(presetAt(0).filters);
  });
});

describe('applying a preset', () => {
  it('puts the view set with the query view as the default', async () => {
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(
          new Response(JSON.stringify({ views: [], unrenderable: [], default: 'query' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );

    const refusal = await applySmartList('item-1', presetAt(2), client());

    expect(refusal).toBeNull();
    const call = calls[0];
    if (call === undefined) {
      throw new Error('No views request was made.');
    }
    const url =
      typeof call.input === 'string'
        ? call.input
        : call.input instanceof Request
          ? call.input.url
          : call.input.toString();
    const body =
      typeof call.init?.body === 'string'
        ? (JSON.parse(call.init.body) as unknown)
        : call.input instanceof Request
          ? ((await call.input.clone().json()) as unknown)
          : {};
    expect(url).toContain('/api/v1/items/item-1/views');
    expect(body).toMatchObject({
      default: 'query',
      views: [{ kind: 'query', name: 'Overdue' }],
    });
  });

  it('answers with a sentence when the views could not be stored, naming the way out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              title: 'Invalid view',
              code: 'views.invalid',
              detail: "'Overdue': 'x' is not a filter operator.",
            }),
            { status: 422, headers: { 'content-type': 'application/problem+json' } },
          ),
        ),
      ),
    );

    const refusal = await applySmartList('item-1', presetAt(2), client());

    expect(refusal).toBe("'Overdue': 'x' is not a filter operator.");
  });

  it('answers with a sentence when the request never reached the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );

    const refusal = await applySmartList('item-1', presetAt(2), client());

    expect(refusal).toContain('Configure them under Views');
  });
});
