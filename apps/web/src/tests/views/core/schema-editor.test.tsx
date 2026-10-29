import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  EffectiveSchema,
  PropertyDefinition,
} from '@nix/web-collections/core/container-model';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { SchemaEditor } from '../../../views/core/schema-editor';
import type { ContainerData, SchemaDraft } from '@nix/web-collections/core/use-container';

/**
 * Declaring properties on a folder.
 *
 * The assertion that matters most is the inheritance one: this editor must save only what the
 * folder declares itself. Bound to the merged schema instead, saving would copy every inherited
 * property onto this folder and sever it from the parent that owns it - a change nobody asked for,
 * visible only later when editing the parent stopped reaching anything.
 */

function propertyOf(overrides: Partial<PropertyDefinition> & { key: string }): PropertyDefinition {
  return {
    label: overrides.key,
    type: 'text',
    options: [],
    required: false,
    ...overrides,
  };
}

/** The second of a set of identically-named controls, failing loudly when there is no second. */
function secondOf<TElement>(elements: readonly TElement[]): TElement {
  const element = elements[1];
  if (element === undefined) {
    throw new Error('Expected at least two matching controls.');
  }
  return element;
}

function containerOf(
  schema: EffectiveSchema | null,
  setSchema: (draft: SchemaDraft) => Promise<string | null> = () => Promise.resolve(null),
): ContainerData {
  return aContainer({ schema, setSchema });
}

describe('the schema editor', () => {
  it('shows the fields this item declares', () => {
    render(
      <SchemaEditor
        container={containerOf({
          properties: [propertyOf({ key: 'status', label: 'Status' })],
          declared: [propertyOf({ key: 'status', label: 'Status' })],
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('Status');
  });

  it('shows an inherited property without offering to edit it', () => {
    render(
      <SchemaEditor
        container={containerOf({
          properties: [propertyOf({ key: 'owner', label: 'Owner' })],
          declared: [],
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    // Visible, so a person can see why a property they did not declare appears on their notes -
    // and not in a field, so they cannot accidentally claim it.
    expect(screen.getByText(/inherited from above/i)).toBeVisible();

    // Named the way the Type control names it, not by the stored token. Somebody reading this list
    // has just chosen types from a select that says "Picture" and "Date and time"; showing them
    // "image" and "timestamp" here would be a second vocabulary for the same nine things.
    expect(screen.getByText(/Owner · Text/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /name/i })).not.toBeInTheDocument();
  });

  it('saves only what this item declares, never what it inherits', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf(
          {
            properties: [
              propertyOf({ key: 'owner', label: 'Owner' }),
              propertyOf({ key: 'status', label: 'Status' }),
            ],
            declared: [propertyOf({ key: 'status', label: 'Status' })],
            inherit: true,
          },
          setSchema,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /save fields/i }));

    // Saving the merged list would copy Owner onto this folder and silently turn inheritance into
    // a copy, after which changing the parent would stop reaching anything below.
    expect(setSchema).toHaveBeenCalledWith({
      inherit: true,
      properties: [expect.objectContaining({ key: 'status' })],
    });
  });

  it('adds a property and derives its key from its name', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true }, setSchema)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /add a property/i }));
    await user.type(screen.getByRole('textbox', { name: /name/i }), 'Due date');
    await user.click(screen.getByRole('button', { name: /save fields/i }));

    expect(setSchema).toHaveBeenCalledWith({
      inherit: true,
      properties: [expect.objectContaining({ key: 'due_date', label: 'Due date' })],
    });
  });

  it('offers an options box only for the types that have options', async () => {
    const user = userEvent.setup();

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true })}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /add a property/i }));
    expect(screen.queryByRole('textbox', { name: /options/i })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'select');
    expect(screen.getByRole('textbox', { name: /options/i })).toBeVisible();
  });

  it('does not send options for a type that cannot carry them', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true }, setSchema)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /add a property/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'select');
    await user.type(screen.getByRole('textbox', { name: /options/i }), 'Todo\nDone');
    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'text');
    await user.click(screen.getByRole('button', { name: /save fields/i }));

    // Cleared at this boundary; the hook is what turns an empty list into the null the contract
    // wants. The server refuses a schema where a non-select carries options, so options left
    // behind after a type change would produce a refusal nobody typed.
    expect(setSchema).toHaveBeenCalledWith({
      inherit: true,
      properties: [expect.objectContaining({ type: 'text', options: [] })],
    });
  });

  it('removes a property', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf(
          {
            properties: [propertyOf({ key: 'status', label: 'Status' })],
            declared: [propertyOf({ key: 'status', label: 'Status' })],
            inherit: true,
          },
          setSchema,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /remove status/i }));
    await user.click(screen.getByRole('button', { name: /save fields/i }));

    expect(setSchema).toHaveBeenCalledWith({ inherit: true, properties: [] });
  });

  it('shows the server s refusal verbatim and stays open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true }, () =>
          Promise.resolve("'title' is managed by the item itself and cannot be redeclared."),
        )}
        open
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: /save fields/i }));

    // Verbatim, because the server names the property at fault and second-guessing it here would
    // be a second validator that can disagree with the first.
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be redeclared/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the save is accepted', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <SchemaEditor
        container={containerOf({ properties: [], declared: [], inherit: true })}
        open
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: /save fields/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it('can refuse everything from above', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf(
          {
            properties: [propertyOf({ key: 'owner', label: 'Owner' })],
            declared: [],
            inherit: true,
          },
          setSchema,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: /ignore fields from items above/i }));
    await user.click(screen.getByRole('button', { name: /save fields/i }));

    // The scratch-folder case: a subtree that would otherwise inherit a dozen required properties
    // and make every note in it invalid on arrival.
    expect(setSchema).toHaveBeenCalledWith({ inherit: false, properties: [] });
  });

  it('offers an expression field only once a property is a formula', async () => {
    const user = userEvent.setup();

    render(
      <SchemaEditor
        container={containerOf({
          properties: [propertyOf({ key: 'total', label: 'Total' })],
          declared: [propertyOf({ key: 'total', label: 'Total' })],
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('textbox', { name: /formula/i })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'formula');

    expect(screen.getByRole('textbox', { name: /formula for total/i })).toBeVisible();
  });

  it('names the other properties a formula can refer to', async () => {
    const user = userEvent.setup();
    const declared = [
      propertyOf({ key: 'estimate', label: 'Estimate', type: 'number' }),
      propertyOf({ key: 'total', label: 'Total' }),
    ];

    render(
      <SchemaEditor
        container={containerOf({ properties: declared, declared, inherit: true })}
        open
        onClose={vi.fn()}
      />,
    );

    const types = screen.getAllByRole('combobox', { name: /type/i });
    await user.selectOptions(secondOf(types), 'formula');

    // The list somebody can check themselves against while typing. Without it a misspelled key is
    // a #NAME? with no way to find out what the right one was.
    expect(screen.getByText(/Available here: \[estimate\]/)).toBeVisible();
  });

  it('does not ask whether a computed property is required', async () => {
    const user = userEvent.setup();

    render(
      <SchemaEditor
        container={containerOf({
          properties: [propertyOf({ key: 'total', label: 'Total' })],
          declared: [propertyOf({ key: 'total', label: 'Total' })],
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: /required/i })).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'formula');

    // Nothing writes a computed value, so there is no value for required to be about - and the
    // server refuses a schema that ticks it.
    expect(screen.queryByRole('checkbox', { name: /required/i })).not.toBeInTheDocument();
  });

  it('sends the expression with the formula it belongs to', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));

    render(
      <SchemaEditor
        container={containerOf(
          {
            properties: [propertyOf({ key: 'total', label: 'Total' })],
            declared: [propertyOf({ key: 'total', label: 'Total' })],
            inherit: true,
          },
          setSchema,
        )}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'formula');
    // `[[` is user-event's escape for a literal bracket: a bare `[` starts a key descriptor.
    // Nothing about the control - somebody typing in a browser presses the key once.
    await user.type(screen.getByRole('textbox', { name: /formula for total/i }), '[[price] * 2');
    await user.click(screen.getByRole('button', { name: /save fields/i }));

    expect(setSchema).toHaveBeenCalledWith({
      inherit: true,
      properties: [
        {
          key: 'total',
          label: 'Total',
          type: 'formula',
          options: [],
          required: false,
          expression: '[price] * 2',
          aggregate: null,
          source: null,
        },
      ],
    });
  });

  it('drops an expression when the property stops being a formula', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));
    const declared = [
      propertyOf({ key: 'total', label: 'Total', type: 'formula', expression: '[price] * 2' }),
    ];

    render(
      <SchemaEditor
        container={containerOf({ properties: declared, declared, inherit: true }, setSchema)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'number');
    await user.click(screen.getByRole('button', { name: /save fields/i }));

    // Left behind, it would start evaluating again the moment somebody retyped the property back
    // to a formula - an expression nobody had looked at in between.
    expect(setSchema).toHaveBeenCalledWith({
      inherit: true,
      properties: [
        {
          key: 'total',
          label: 'Total',
          type: 'number',
          options: [],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
        },
      ],
    });
  });

  it('offers the inherited properties as references, since a formula can read them', async () => {
    const user = userEvent.setup();
    const declared = [propertyOf({ key: 'total', label: 'Total' })];

    render(
      <SchemaEditor
        container={containerOf({
          properties: [...declared, propertyOf({ key: 'estimate', label: 'Estimate' })],
          declared,
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'formula');

    // Evaluation reads the effective schema, so an inherited key is perfectly referenceable - and
    // this dialog lists it under "Inherited from above" in the same scroll. A hint calling it
    // unavailable would contradict the panel below it.
    expect(screen.getByText(/Inherited: \[estimate\]/)).toBeVisible();
  });

  it('stops offering inherited formula references when their inheritance is disabled', async () => {
    const user = userEvent.setup();
    const declared = [
      propertyOf({ key: 'total', label: 'Total', type: 'formula', expression: '[estimate] * 2' }),
    ];
    render(
      <SchemaEditor
        container={containerOf({
          properties: [
            ...declared,
            propertyOf({ key: 'estimate', label: 'Estimate', type: 'number' }),
          ],
          declared,
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /ignore fields from items above/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/\[estimate\].*#NAME\?/);
    expect(screen.queryByText(/Inherited: \[estimate\]/)).not.toBeInTheDocument();
  });

  it('says so while typing when an expression will not parse', async () => {
    const user = userEvent.setup();

    render(
      <SchemaEditor
        container={containerOf({
          properties: [propertyOf({ key: 'total', label: 'Total' })],
          declared: [propertyOf({ key: 'total', label: 'Total' })],
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'formula');
    await user.type(screen.getByRole('textbox', { name: /formula for total/i }), '1 +');

    expect(screen.getByRole('alert')).toHaveTextContent(/#PARSE!/);
  });

  it('names a reference nothing here declares, rather than leaving it to be discovered', async () => {
    const user = userEvent.setup();

    render(
      <SchemaEditor
        container={containerOf({
          properties: [propertyOf({ key: 'total', label: 'Total' })],
          declared: [propertyOf({ key: 'total', label: 'Total' })],
          inherit: true,
        })}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'formula');
    await user.type(screen.getByRole('textbox', { name: /formula for total/i }), '[[prise] * 2');

    expect(screen.getByRole('alert')).toHaveTextContent(/\[prise\].*#NAME\?/);
  });

  it.each([
    ['NOPE(1)', /NOPE is not a supported function/],
    ['NOT(TRUE, FALSE)', /NOT expects 1 argument/],
    ['A1 * 2', /cannot read spreadsheet cells/],
    ['=1 + 2', /without a leading =/],
  ])('explains a known-invalid formula %s while typing', async (expression, message) => {
    const user = userEvent.setup();
    const declared = [
      propertyOf({ key: 'total', label: 'Total', type: 'formula', expression: '' }),
    ];
    render(
      <SchemaEditor
        container={containerOf({ properties: declared, declared, inherit: true })}
        open
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox', { name: /formula for total/i });
    expect(input).toHaveAttribute('maxlength', '1024');
    expect(screen.getByText(/Functions:.*IFERROR.*ISBLANK/)).toBeVisible();
    await user.type(input, expression);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('offers a fold and a property to fold once a property is a rollup', async () => {
    const user = userEvent.setup();
    const declared = [
      propertyOf({ key: 'estimate', label: 'Estimate', type: 'number' }),
      propertyOf({ key: 'hours', label: 'Hours' }),
    ];

    render(
      <SchemaEditor
        container={containerOf({ properties: declared, declared, inherit: true })}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(
      secondOf(screen.getAllByRole('combobox', { name: /type/i })),
      'rollup',
    );

    const fold = screen.getByRole('combobox', { name: /how hours folds the children/i });
    expect(fold).toBeVisible();

    await user.selectOptions(fold, 'sum');

    expect(screen.getByRole('combobox', { name: /which property hours folds/i })).toBeVisible();
  });

  it('does not ask which property a count of the children folds', async () => {
    const user = userEvent.setup();
    const declared = [propertyOf({ key: 'hours', label: 'Hours' })];

    render(
      <SchemaEditor
        container={containerOf({ properties: declared, declared, inherit: true })}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'rollup');

    // "How many" is the one fold that answers a question about the container rather than about a
    // property of its contents, so there is nothing for a picker to mean.
    expect(screen.getByRole('combobox', { name: /how hours folds/i })).toHaveValue('count');
    expect(screen.queryByRole('combobox', { name: /which property/i })).not.toBeInTheDocument();
  });

  it('says so while a rollup that needs a property has not been given one', async () => {
    const user = userEvent.setup();
    const declared = [
      propertyOf({ key: 'estimate', label: 'Estimate', type: 'number' }),
      propertyOf({ key: 'hours', label: 'Hours' }),
    ];

    render(
      <SchemaEditor
        container={containerOf({ properties: declared, declared, inherit: true })}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(
      secondOf(screen.getAllByRole('combobox', { name: /type/i })),
      'rollup',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /how hours folds/i }), 'sum');

    expect(screen.getByRole('alert')).toHaveTextContent(/Choose a property to fold/);
  });

  it('sends the fold and the folded property with the rollup', async () => {
    const user = userEvent.setup();
    const setSchema = vi.fn(() => Promise.resolve(null));
    const declared = [
      propertyOf({ key: 'estimate', label: 'Estimate', type: 'number' }),
      propertyOf({ key: 'hours', label: 'Hours' }),
    ];

    render(
      <SchemaEditor
        container={containerOf({ properties: declared, declared, inherit: true }, setSchema)}
        open
        onClose={vi.fn()}
      />,
    );

    await user.selectOptions(
      secondOf(screen.getAllByRole('combobox', { name: /type/i })),
      'rollup',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /how hours folds/i }), 'sum');
    await user.selectOptions(
      screen.getByRole('combobox', { name: /which property hours folds/i }),
      'estimate',
    );
    await user.click(screen.getByRole('button', { name: /save fields/i }));

    expect(setSchema).toHaveBeenCalledWith({
      inherit: true,
      properties: [
        declared[0],
        {
          key: 'hours',
          label: 'Hours',
          type: 'rollup',
          options: [],
          required: false,
          expression: null,
          aggregate: 'sum',
          source: 'estimate',
        },
      ],
    });
  });

  it('does not offer a computed property as something to fold', async () => {
    const user = userEvent.setup();
    const declared = [
      propertyOf({ key: 'estimate', label: 'Estimate', type: 'number' }),
      propertyOf({ key: 'double', label: 'Double', type: 'formula', expression: '[estimate] * 2' }),
      propertyOf({ key: 'hours', label: 'Hours' }),
    ];

    render(
      <SchemaEditor
        container={containerOf({ properties: declared, declared, inherit: true })}
        open
        onClose={vi.fn()}
      />,
    );

    const types = screen.getAllByRole('combobox', { name: /type/i });
    const third = types[2];
    if (third === undefined) {
      throw new Error('Expected three type controls.');
    }
    await user.selectOptions(third, 'rollup');
    await user.selectOptions(screen.getByRole('combobox', { name: /how hours folds/i }), 'sum');

    // Folding a formula would be a dependency walk over rows the server does not hold, and folding
    // a rollup would be folding a fold.
    const picker = screen.getByRole('combobox', { name: /which property hours folds/i });
    expect(within(picker).queryByRole('option', { name: 'double' })).not.toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'estimate' })).toBeInTheDocument();
  });
});

it('saves a field source without changing the field type or unrelated declarations', async () => {
  const user = userEvent.setup();
  const who = propertyOf({ key: 'who', label: 'Who offended you' });
  const reason = propertyOf({ key: 'reason', label: 'Reason' });
  const setSchema = vi.fn(() => Promise.resolve(null));
  render(
    <SchemaEditor
      container={containerOf(
        { properties: [who, reason], declared: [who, reason], inherit: true },
        setSchema,
      )}
      open
      onClose={vi.fn()}
    />,
  );
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Suggestions for Who offended you' }),
    'previous',
  );
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Source field for Who offended you' }),
    'reason',
  );
  await user.click(screen.getByRole('button', { name: 'Save fields' }));
  expect(setSchema).toHaveBeenCalledWith({
    inherit: true,
    properties: [{ ...who, choiceSource: { itemId: null, field: 'reason' } }, reason],
  });
});

it('does not save an unfinished source-note selection', async () => {
  const user = userEvent.setup();
  const who = propertyOf({ key: 'who', label: 'Who' });
  const setSchema = vi.fn(() => Promise.resolve(null));
  render(
    <SchemaEditor
      container={containerOf({ properties: [who], declared: [who], inherit: true }, setSchema)}
      open
      onClose={vi.fn()}
    />,
  );
  await user.selectOptions(screen.getByRole('combobox', { name: 'Suggestions for Who' }), 'other');
  await user.click(screen.getByRole('button', { name: 'Save fields' }));
  expect(setSchema).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Choose a source note for Who before saving.',
  );
});

it('keeps a new field learning from itself while its name is being edited', async () => {
  const user = userEvent.setup();
  const setSchema = vi.fn(() => Promise.resolve(null));
  render(
    <SchemaEditor
      container={containerOf({ properties: [], declared: [], inherit: true }, setSchema)}
      open
      onClose={vi.fn()}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Add a property' }));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Person');
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Suggestions for Person' }),
    'previous',
  );
  await user.clear(screen.getByRole('textbox', { name: 'Name' }));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Who');
  await user.click(screen.getByRole('button', { name: 'Save fields' }));
  expect(setSchema).toHaveBeenCalledWith({
    inherit: true,
    properties: [
      expect.objectContaining({ key: 'who', choiceSource: { itemId: null, field: 'who' } }),
    ],
  });
});
