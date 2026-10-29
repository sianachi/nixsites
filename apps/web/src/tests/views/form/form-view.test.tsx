import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aContainer } from '../../container-fixture';
import { aView, schemaOf } from '../../view-fixture';
import type {
  EffectiveSchema,
  PropertyDefinition,
  View,
} from '../../../views/core/container-model';
import { FormView } from '../../../views/form/form-view';

/**
 * The form view, driven the way a person fills it: type into fields, press the button, read the
 * answer. The create is the container's own; these tests assert what it is handed and what the
 * form says about the outcome.
 */

function property(
  key: string,
  label: string,
  type: string,
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return { key, label, type, options: [], required: false, ...overrides };
}

const SCHEMA = schemaOf(
  property('mood', 'Mood', 'select', { options: ['Good', 'Flat'] }),
  property('sleep', 'Sleep', 'number'),
  property('notes', 'Notes', 'text'),
);

function formAt(options: {
  readonly schema?: EffectiveSchema | null;
  readonly view?: View;
  readonly create?: (title: string, properties?: Record<string, unknown>) => Promise<string | null>;
}): { created: { title: string; properties: Record<string, unknown> | undefined }[] } {
  const created: { title: string; properties: Record<string, unknown> | undefined }[] = [];

  const container = aContainer({
    schema: options.schema === undefined ? SCHEMA : options.schema,
    create:
      options.create ??
      ((title, properties) => {
        created.push({ title, properties });
        return Promise.resolve(null);
      }),
  });

  renderAt(
    <FormView
      container={container}
      view={options.view ?? aView({ kind: 'form' })}
      onOpen={vi.fn()}
    />,
  );

  return { created };
}

describe('the fields', () => {
  it('offers the declared schema in order, title first, when the view names nothing', () => {
    formAt({});

    const labels = screen.getAllByRole('textbox').map((control) => control.getAttribute('id'));
    expect(labels.length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Title/)).toBeInTheDocument();
    expect(screen.getByLabelText('Mood')).toBeInTheDocument();
    expect(screen.getByLabelText('Sleep')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
  });

  it('offers only the columns the view names, in the view’s order', () => {
    formAt({ view: aView({ kind: 'form', columns: ['notes', 'mood'] }) });

    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
    expect(screen.getByLabelText('Mood')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sleep')).toBeNull();
  });

  it('names a configured field the schema no longer describes instead of dropping it silently', () => {
    formAt({ view: aView({ kind: 'form', columns: ['ghost', 'mood'] }) });

    expect(
      screen.getByText('The configured field "ghost" cannot be offered as an input here.'),
    ).toBeInTheDocument();
  });

  it('names a field whose type this build has no control for, with the same sentence', () => {
    // The other route to the gap: the schema describes the key, but the type is from a newer
    // build. "Not in the schema" would send somebody to add a property that is already there.
    formAt({
      schema: schemaOf(property('shape', 'Shape', 'polygon')),
    });

    expect(
      screen.getByText('The configured field "shape" cannot be offered as an input here.'),
    ).toBeInTheDocument();
  });

  it('announces the title as required, not only as an asterisk', () => {
    formAt({});

    expect(screen.getByLabelText(/Title/)).toBeRequired();
  });

  it('still takes a title when there is no schema at all, and says what that means', () => {
    formAt({ schema: null });

    expect(screen.getByLabelText(/Title/)).toBeInTheDocument();
    expect(screen.getByText(/entries carry only a title/)).toBeInTheDocument();
  });
});

describe('submitting', () => {
  it('creates a child from the title and the committed values, then clears for the next entry', async () => {
    const user = userEvent.setup();
    const { created } = formAt({});

    await user.type(screen.getByLabelText(/Title/), 'Tuesday');
    const sleep = screen.getByLabelText('Sleep');
    await user.type(sleep, '6.5');
    fireEvent.blur(sleep);
    await user.selectOptions(screen.getByLabelText('Mood'), 'Flat');

    await user.click(screen.getByRole('button', { name: 'Add entry' }));

    expect(created).toEqual([{ title: 'Tuesday', properties: { sleep: 6.5, mood: 'Flat' } }]);
    expect(await screen.findByText(/Entry added/)).toBeInTheDocument();
    // Cleared, ready for the next one.
    expect(screen.getByLabelText(/Title/)).toHaveValue('');
    expect(screen.getByLabelText('Sleep')).toHaveValue(null);
  });

  it('blocks an empty required field with a message on the field, and says the form owns the rule', async () => {
    const user = userEvent.setup();
    const { created } = formAt({
      schema: schemaOf(property('mood', 'Mood', 'select', { options: ['Good'], required: true })),
    });

    await user.type(screen.getByLabelText(/Title/), 'Tuesday');
    await user.click(screen.getByRole('button', { name: 'Add entry' }));

    expect(created).toEqual([]);
    expect(screen.getByText('Required before the entry is added.')).toBeInTheDocument();
    expect(
      screen.getByText('The entry was not added: one field still needs a value.'),
    ).toBeInTheDocument();
  });

  it('requires a title before anything is sent', async () => {
    const user = userEvent.setup();
    const { created } = formAt({});

    await user.click(screen.getByRole('button', { name: 'Add entry' }));

    expect(created).toEqual([]);
    expect(screen.getByText('An entry needs a title.')).toBeInTheDocument();
  });

  it('shows the server’s refusal verbatim and keeps the draft for correction', async () => {
    const user = userEvent.setup();
    formAt({
      create: () => Promise.resolve('The value for Mood is not one of the options.'),
    });

    await user.type(screen.getByLabelText(/Title/), 'Tuesday');
    await user.click(screen.getByRole('button', { name: 'Add entry' }));

    expect(
      await screen.findByText('The value for Mood is not one of the options.'),
    ).toBeInTheDocument();
    // The draft survives a refusal - clearing it would throw away the entry being corrected.
    expect(screen.getByLabelText(/Title/)).toHaveValue('Tuesday');
  });

  it('reports a create that could not be sent at all', async () => {
    const user = userEvent.setup();
    formAt({ create: () => Promise.reject(new Error('offline')) });

    await user.type(screen.getByLabelText(/Title/), 'Tuesday');
    await user.click(screen.getByRole('button', { name: 'Add entry' }));

    expect(
      await screen.findByText('The entry could not be sent. Check the connection and try again.'),
    ).toBeInTheDocument();
  });

  it('sends an explicit false for a required checkbox nobody touched', async () => {
    // Unanswered and unchecked are indistinguishable in the control, so the required check
    // exempts it - and the bag is completed instead, so what is stored still carries a value.
    const user = userEvent.setup();
    const { created } = formAt({
      schema: schemaOf(property('done', 'Done', 'checkbox', { required: true })),
    });

    await user.type(screen.getByLabelText(/Title/), 'Tuesday');
    await user.click(screen.getByRole('button', { name: 'Add entry' }));

    expect(created).toEqual([{ title: 'Tuesday', properties: { done: false } }]);
  });

  it('moves focus to the first blocked field, so a repeated blocked submit is never silent', async () => {
    const user = userEvent.setup();
    formAt({
      schema: schemaOf(property('mood', 'Mood', 'select', { options: ['Good'], required: true })),
    });

    await user.type(screen.getByLabelText(/Title/), 'Tuesday');
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    expect(screen.getByLabelText(/Mood/)).toHaveFocus();

    // The second identical submit changes no text, so no live region re-announces - the focus
    // move is the feedback that works every time.
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    expect(screen.getByLabelText(/Mood/)).toHaveFocus();
  });
});

describe('surviving the reload a create causes', () => {
  it('keeps the form mounted through the post-create reload, announces, and returns focus', async () => {
    // `container.create` reloads the children on success, which flips status through 'loading'.
    // A form that unmounted for that reload would lose the success sentence, the announcement and
    // the focus return - this container moves status exactly the way the real hook does, which
    // the static fixture cannot.
    const user = userEvent.setup();
    const created: string[] = [];

    function Harness(): ReactNode {
      const [status, setStatus] = useState<'ready' | 'loading'>('ready');

      const container = aContainer({
        status,
        schema: SCHEMA,
        create: async (title) => {
          created.push(title);
          setStatus('loading');
          await new Promise((resolve) => setTimeout(resolve, 0));
          setStatus('ready');
          return null;
        },
      });

      return <FormView container={container} view={aView({ kind: 'form' })} onOpen={vi.fn()} />;
    }

    renderAt(<Harness />);

    await user.type(screen.getByLabelText(/Title/), 'Tuesday');
    await user.click(screen.getByRole('button', { name: 'Add entry' }));

    expect(created).toEqual(['Tuesday']);
    expect(await screen.findByText('Entry added.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Title/)).toHaveValue('');
    expect(screen.getByLabelText(/Title/)).toHaveFocus();
  });

  it('still shows the loading panel on first arrival', () => {
    renderAt(
      <FormView
        container={aContainer({ status: 'loading' })}
        view={aView({ kind: 'form' })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText(/Loading this form/)).toBeInTheDocument();
  });

  it('offers a retry when the container could not be read', () => {
    const reload = vi.fn(() => Promise.resolve());
    renderAt(
      <FormView
        container={aContainer({ status: 'error', error: 'Core said no.', reload })}
        view={aView({ kind: 'form' })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('Core said no.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalled();
  });
});

describe('a computed property on a form', () => {
  it('offers computed properties as results rather than editable inputs', () => {
    formAt({
      schema: schemaOf(
        property('sleep', 'Sleep', 'number'),
        property('rested', 'Rested', 'formula', { expression: '[sleep] > 7' }),
      ),
    });

    expect(screen.getByRole('spinbutton', { name: /sleep/i })).toBeVisible();
    expect(screen.getByLabelText('Rested')).toHaveTextContent('No');
    expect(screen.queryByRole('textbox', { name: 'Rested' })).not.toBeInTheDocument();
  });

  it('is not reported as unavailable either, because nothing about it is broken', () => {
    // "Unavailable" is for a field that was meant to be an input and is not one - a renamed
    // property, a type this build cannot draw. A formula is working exactly as declared.
    formAt({
      schema: schemaOf(property('rested', 'Rested', 'formula', { expression: '1' })),
    });

    expect(screen.queryByText(/cannot be offered as inputs here/i)).not.toBeInTheDocument();
  });
});

describe('temporary calculations', () => {
  const calculator = schemaOf(
    property('weight', 'Weight', 'number', { required: true }),
    property('height', 'Height', 'number', { required: true }),
    property('bmi', 'BMI', 'formula', { expression: 'ROUND([weight] / ([height] * [height]), 1)' }),
  );

  it('calculates inputs locally without a title or create, and clears every draft input', async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => Promise.resolve(null));
    formAt({ schema: calculator, view: aView({ kind: 'form', mode: 'temporary' }), create });

    expect(screen.getByRole('checkbox', { name: 'Save this entry' })).not.toBeChecked();
    expect(screen.queryByLabelText(/Title/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/Weight/), '72');
    await user.type(screen.getByLabelText(/Height/), '1.8');
    await user.click(screen.getByRole('button', { name: 'Calculate' }));
    expect(screen.getByLabelText('BMI')).toHaveTextContent('22.2');
    expect(screen.getByText('Calculated here. No entry was saved.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Clear inputs' }));
    expect(screen.getByLabelText(/Weight/)).toHaveValue(null);
    expect(screen.getByLabelText(/Height/)).toHaveValue(null);
  });

  it('saves only input properties after the person opts into saving', async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => Promise.resolve(null));
    formAt({ schema: calculator, view: aView({ kind: 'form', mode: 'temporary' }), create });
    await user.type(screen.getByLabelText(/Weight/), '72');
    await user.type(screen.getByLabelText(/Height/), '1.8');
    await user.click(screen.getByRole('checkbox', { name: 'Save this entry' }));
    await user.type(screen.getByLabelText(/Title/), 'Check-in');
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    expect(create).toHaveBeenCalledExactlyOnceWith('Check-in', { weight: 72, height: 1.8 });
  });
});
