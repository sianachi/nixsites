import { WORKSPACE_OPERATIONS } from '@nix/structure-spec';
import { flattenToolExample, TOOL_EXAMPLES } from '@nix/structure-spec/testing';
import { describe, expect, it } from 'vitest';

import { flattenToolCall, toolArgParams, toolIdentity, validateToolArguments } from './flatten.ts';
import { IDS } from './testing.ts';
import { goJson } from './util.ts';

const ID = IDS.item;
const flat = (operation: string, fields: Record<string, string> = {}): string =>
  JSON.stringify({
    operation,
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
    ...fields,
  });
const ok = (tool: string, args: unknown): Record<string, string> => {
  const result = flattenToolCall(tool, args);
  expect(result.reason).toBe('');
  return JSON.parse(result.flat ?? '{}') as Record<string, string>;
};

/** Parsed deeply, so key order and JSON spacing inside the string members do not matter. */
const deep = (value: Record<string, string>): unknown =>
  Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      ['propertiesJson', 'specJson', 'query'].includes(k) && v.startsWith('{') ? JSON.parse(v) : v,
    ]),
  );

describe('flattenToolCall', () => {
  it('matches the structure-spec reference for every operation example', () => {
    for (const operation of WORKSPACE_OPERATIONS) {
      const args = TOOL_EXAMPLES[operation];
      expect(deep(ok(`nix_${operation}`, args)), operation).toEqual(
        deep(flattenToolExample(operation, args) as unknown as Record<string, string>),
      );
    }
  });

  it('knows exactly the operations the catalog offers', () => {
    expect([...WORKSPACE_OPERATIONS].sort()).toEqual(Object.keys(TOOL_EXAMPLES).sort());
    for (const operation of WORKSPACE_OPERATIONS)
      expect(toolArgParams(operation).length, operation).toBeGreaterThanOrEqual(0);
  });

  it('flattens every example into arguments the validator accepts', () => {
    for (const operation of WORKSPACE_OPERATIONS) {
      const result = flattenToolCall(`nix_${operation}`, TOOL_EXAMPLES[operation]);
      expect(validateToolArguments(result.flat ?? ''), operation).toBe('');
    }
  });

  it('refuses unknown parameters, naming what the tool accepts', () => {
    const result = flattenToolCall('nix_read_item', { itemId: ID, bogus: 'x' });
    expect(result.reason).toBe('"bogus" is not a parameter of nix_read_item; it accepts itemId.');
    expect(flattenToolCall('nix_search_note', { foo: 1 }).reason).toContain(
      'it accepts itemId, query.',
    );
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const raw: unknown = JSON.parse(`{"itemId":"${ID}","${key}":{}}`);
      expect(flattenToolCall('nix_read_item', raw).reason, key).toContain('is not a parameter');
    }
  });

  it('refuses wrong shapes with the tool and key named', () => {
    expect(flattenToolCall('nix_search', { query: 5 }).reason).toBe(
      'nix_search.query must be a string.',
    );
    expect(flattenToolCall('nix_set_properties', { itemId: ID, properties: [] }).reason).toBe(
      'nix_set_properties.properties must be a JSON object.',
    );
    expect(
      flattenToolCall('nix_set_properties', { itemId: ID, properties: 'not json' }).reason,
    ).toBe('nix_set_properties.properties must be a JSON object.');
    expect(flattenToolCall('nix_read_calendar', { from: 5 }).reason).toBe(
      'nix_read_calendar.from must be a string, a boolean or an object.',
    );
    expect(flattenToolCall('nix_read_item', 'text').reason).toBe(
      'nix_read_item requires a JSON object of arguments.',
    );
    expect(flattenToolCall('nix_read_item', null).reason).toBe(
      'nix_read_item requires a JSON object of arguments.',
    );
    expect(flattenToolCall('nix_workspace', {}).reason).toBe(
      'nix_workspace is not a supported tool.',
    );
  });

  it('accepts an object parameter a provider sent as JSON text, with sorted canonical keys', () => {
    const result = ok('nix_set_properties', {
      itemId: ID,
      properties: '{"b":1,"a":{"z":true,"y":null}}',
    });
    expect(result.propertiesJson).toBe('{"a":{"y":null,"z":true},"b":1}');
    expect(result.operation).toBe('set_properties');
  });

  it('maps templateId to itemId, heading and find to query, replace and fact to markdown', () => {
    expect(ok('nix_read_template', { templateId: ID })).toMatchObject({
      operation: 'read_template',
      itemId: ID,
    });
    expect(ok('nix_replace_section', { itemId: ID, heading: 'Plan', markdown: 'x' })).toMatchObject(
      { query: 'Plan', markdown: 'x' },
    );
    expect(ok('nix_replace_passage', { itemId: ID, find: 'a', replace: 'b' })).toMatchObject({
      query: 'a',
      markdown: 'b',
    });
    expect(ok('nix_remember', { fact: 'Metric units.' })).toMatchObject({
      markdown: 'Metric units.',
    });
    expect(ok('nix_run_action', { actionId: 'KeepItem' })).toMatchObject({ query: 'KeepItem' });
  });

  it('folds scalar parameters into one specJson object', () => {
    expect(
      JSON.parse(ok('nix_read_calendar', { from: '2026-10-05', to: '2026-10-11' }).specJson ?? ''),
    ).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(
      JSON.parse(ok('nix_complete_task', { itemId: ID, completed: false }).specJson ?? ''),
    ).toEqual({ completed: false });
    const move = ok('nix_move_item', {
      itemId: ID,
      parentId: '',
      destinationWorkspaceId: IDS.other,
    });
    expect(JSON.parse(move.specJson ?? '')).toEqual({ destinationWorkspaceId: IDS.other });
    expect(
      JSON.parse(
        ok('nix_run_action', { actionId: 'A', path: { a: 1 }, params: { b: 2 } }).specJson ?? '',
      ),
    ).toEqual({ path: { a: 1 }, params: { b: 2 } });
  });

  it('writes the flat fields in a fixed order', () => {
    expect(flattenToolCall('nix_list_items', {}).flat).toBe(
      '{"operation":"list_items","itemId":"","parentId":"","title":"","markdown":"","query":"","propertiesJson":"","specJson":""}',
    );
  });
});

describe('validateToolArguments', () => {
  it('refuses non-flat arguments', () => {
    expect(validateToolArguments('[]')).toContain('JSON object with string fields');
    expect(validateToolArguments('{"operation":"search","query":1}')).toContain('string fields');
    expect(validateToolArguments('{"operation":"search","query":"a","extra":"b"}')).toContain(
      'string fields',
    );
    expect(validateToolArguments(flat('delete_everything'))).toBe(
      'Unsupported workspace operation.',
    );
  });

  it('requires exact ids, naming the parameter the model typed', () => {
    expect(validateToolArguments(flat('read_note', { itemId: 'nope' }))).toBe(
      'itemId must be a Nix item UUID.',
    );
    expect(validateToolArguments(flat('read_note'))).toContain(
      'nix_read_note requires the exact itemId UUID',
    );
    expect(validateToolArguments(flat('read_template', { itemId: 'nope' }))).toBe(
      'templateId must be a Nix item UUID.',
    );
    expect(validateToolArguments(flat('apply_template', { title: 't' }))).toContain(
      'exact templateId UUID',
    );
    expect(validateToolArguments(flat('create_note', { title: 't', parentId: 'nope' }))).toContain(
      'parentId must be a Nix item UUID or empty',
    );
  });

  it('enforces the size, depth and spec/markdown rules', () => {
    expect(validateToolArguments(flat('create_note', { title: 'x'.repeat(241) }))).toBe(
      'Tool arguments exceed the supported size limit.',
    );
    expect(
      validateToolArguments(
        flat('create_structured', { title: 't', specJson: `{"a":"${'x'.repeat(24000)}"}` }),
      ),
    ).toBe('The design is too large. Use fewer items and fields.');
    expect(
      validateToolArguments(
        flat('create_structured', {
          title: 't',
          specJson: `${'{"a":'.repeat(25)}1${'}'.repeat(25)}`,
        }),
      ),
    ).toBe('The design is too large. Use fewer items and fields.');
    expect(
      validateToolArguments(
        flat('create_structured', {
          title: 't',
          specJson: `${'{"a":'.repeat(24)}1${'}'.repeat(24)}`,
        }),
      ),
    ).toBe('');
    expect(
      validateToolArguments(
        flat('create_structured', { title: 't', specJson: '{}', markdown: 'm' }),
      ),
    ).toBe('Put markdown inside spec entries, not alongside it.');
    expect(
      validateToolArguments(
        flat('replace_passage', { itemId: ID, query: 'x'.repeat(241), markdown: 'y' }),
      ),
    ).toContain('find is limited to 240 characters');
  });

  it('validates the body edits, structure writes and actions', () => {
    expect(validateToolArguments(flat('replace_section', { itemId: ID, query: 'H' }))).toContain(
      'never empties a section',
    );
    expect(validateToolArguments(flat('replace_section', { itemId: ID, markdown: 'm' }))).toContain(
      'heading of the section',
    );
    expect(validateToolArguments(flat('replace_passage', { itemId: ID, markdown: 'm' }))).toContain(
      'exact text to find',
    );
    expect(validateToolArguments(flat('append_note', { itemId: ID }))).toContain(
      'nonempty markdown',
    );
    expect(validateToolArguments(flat('rename_item', { itemId: ID }))).toContain(
      'requires a title',
    );
    expect(
      validateToolArguments(flat('set_properties', { itemId: ID, propertiesJson: '[]' })),
    ).toContain('properties (a JSON object)');
    expect(validateToolArguments(flat('create_entries', { parentId: ID }))).toContain(
      'requires spec',
    );
    expect(validateToolArguments(flat('edit_form', { itemId: ID, specJson: '5' }))).toContain(
      'edit_form requires spec',
    );
    expect(validateToolArguments(flat('build_blueprint', { specJson: '' }))).toContain(
      'requires blueprint',
    );
    expect(
      validateToolArguments(flat('apply_template', { itemId: ID, title: 't', specJson: '[]' })),
    ).toContain('when supplied');
    expect(validateToolArguments(flat('read_view', { itemId: ID, query: 'x' }))).toContain(
      'exact viewId',
    );
    expect(validateToolArguments(flat('find_action'))).toContain('nonempty query');
    expect(validateToolArguments(flat('run_action', { query: 'A', specJson: '[]' }))).toContain(
      'must be JSON objects',
    );
    expect(validateToolArguments(flat('search_note', { itemId: ID }))).toContain('nonempty query');
  });

  it('validates the calendar window and task completion', () => {
    const calendar = (from: string, to: string): string =>
      validateToolArguments(flat('read_calendar', { specJson: JSON.stringify({ from, to }) }));
    expect(calendar('2026-10-01', '2026-10-31')).toBe('');
    expect(calendar('2026-10-01', '2026-11-01')).toBe(
      'nix_read_calendar reads at most 31 days at a time. Split the range.',
    );
    expect(calendar('2026-10-05', '2026-10-01')).toBe(
      'nix_read_calendar requires from on or before to.',
    );
    expect(calendar('Oct 1', '2026-10-31')).toBe(
      'nix_read_calendar requires from and to as yyyy-MM-dd days.',
    );
    expect(validateToolArguments(flat('complete_task', { itemId: ID, specJson: '{}' }))).toBe(
      'nix_complete_task requires completed (true or false).',
    );
    expect(
      validateToolArguments(flat('complete_task', { itemId: ID, specJson: '{"completed":false}' })),
    ).toBe('');
  });

  it('takes remember facts of at most 280 visible characters', () => {
    expect(validateToolArguments(flat('remember', { markdown: 'Prefers metric units.' }))).toBe('');
    expect(validateToolArguments(flat('remember', { markdown: '  ' }))).toContain('at most 280');
    expect(validateToolArguments(flat('remember', { markdown: 'a'.repeat(281) }))).toContain(
      'at most 280',
    );
    expect(validateToolArguments(flat('remember', { markdown: 'é'.repeat(280) }))).toBe('');
    for (const bad of ['hidden​text', 'tab\there', 'bell\u0007', 'line break', 'privateuse']) {
      expect(validateToolArguments(flat('remember', { markdown: bad })), JSON.stringify(bad)).toBe(
        'nix_remember takes visible text only.',
      );
    }
  });
});

describe('toolIdentity', () => {
  it('treats reordered keys as one action and a changed payload as another', () => {
    const a = toolIdentity(flat('set_properties', { itemId: ID, propertiesJson: '{"a":1,"b":2}' }));
    const b = toolIdentity(
      flat('set_properties', { itemId: ID, propertiesJson: '{ "b": 2, "a": 1 }' }),
    );
    const c = toolIdentity(flat('set_properties', { itemId: ID, propertiesJson: '{"a":1,"b":3}' }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.readOnly).toBe(false);
  });

  it('normalises the view query only for read_view', () => {
    const view = (query: string): string =>
      toolIdentity(flat('read_view', { itemId: ID, query })).fingerprint;
    expect(view('{"viewId":"a","pageSize":5}')).toBe(view('{"pageSize":5,"viewId":"a"}'));
    const search = (query: string): string => toolIdentity(flat('search', { query })).fingerprint;
    expect(search('{"a":1,"b":2}')).not.toBe(search('{"b":2,"a":1}'));
  });

  it('pins which operations are read only', () => {
    const reads = [
      'list_items',
      'search',
      'read_item',
      'read_note',
      'search_note',
      'read_structure',
      'read_view',
      'list_templates',
      'read_template',
      'read_calendar',
      'remember',
      'find_action',
    ];
    for (const operation of WORKSPACE_OPERATIONS) {
      expect(toolIdentity(flat(operation)).readOnly, operation).toBe(reads.includes(operation));
    }
  });

  it('has no fingerprint for text that is not a JSON object', () => {
    expect(toolIdentity('nope').fingerprint).toBe('');
    expect(toolIdentity('[]').fingerprint).toBe('');
  });
});

describe('goJson', () => {
  it('sorts keys and escapes the way Go does', () => {
    expect(goJson({ b: 1, a: '<&>', c: [{ z: 1, y: 2 }] })).toBe(
      '{"a":"\\u003c\\u0026\\u003e","b":1,"c":[{"y":2,"z":1}]}',
    );
  });
});
