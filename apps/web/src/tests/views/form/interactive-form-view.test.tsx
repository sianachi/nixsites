import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { InteractiveFormView } from '../../../views/form/interactive-form-view';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aView } from '@nix/web-collections/testing/view-fixture';

const interactiveForm = {
  pages: [
    {
      id: 'start',
      title: 'Check in',
      description: null,
      visibleWhen: [],
      blocks: [
        {
          id: 'mood',
          kind: 'field',
          propertyKey: 'mood',
          text: 'Mood',
          help: null,
          required: true,
          identityRole: null,
          visibleWhen: [],
        },
      ],
    },
    {
      id: 'detail-page',
      title: 'Tell us more',
      description: null,
      visibleWhen: [{ fieldBlockId: 'mood', operator: 'equals', value: 'Low' }],
      blocks: [
        {
          id: 'detail',
          kind: 'field',
          propertyKey: 'detail',
          text: 'What happened?',
          help: null,
          required: true,
          identityRole: null,
          visibleWhen: [],
        },
      ],
    },
  ],
  titleMode: 'field',
  titleFieldBlockId: 'mood',
  confirmationTitle: 'Recorded',
  confirmationMessage: 'Thanks for checking in.',
};

function renderForm(
  create: (title: string, properties?: Record<string, unknown>) => Promise<string | null>,
  mode: string | null = null,
): void {
  renderAt(
    <InteractiveFormView
      container={aContainer({
        schema: {
          properties: [
            {
              key: 'mood',
              label: 'Mood',
              type: 'select',
              options: ['Good', 'Low'],
              required: false,
            },
            { key: 'detail', label: 'Detail', type: 'text', options: [], required: false },
            {
              key: 'detail_length',
              label: 'Detail length',
              type: 'formula',
              expression: 'LEN([detail])',
              options: [],
              required: false,
            },
          ],
          declared: [],
          inherit: true,
        },
        create,
      })}
      view={aView({ kind: 'interactive_form', interactiveForm, mode })}
      onOpen={vi.fn()}
    />,
  );
}

describe('interactive forms', () => {
  it('calculates only answers still visible after a conditional page is hidden', async () => {
    const create = vi.fn(() => Promise.resolve(null));
    const user = userEvent.setup();
    renderForm(create, 'temporary');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Mood' }), 'Low');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByRole('textbox', { name: 'What happened?' }), 'Busy');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Mood' }), 'Good');
    await user.click(screen.getByRole('button', { name: 'Show results' }));
    expect(screen.getByLabelText('Detail length')).toHaveTextContent('0');
    expect(create).not.toHaveBeenCalled();
  });
  it('keeps a temporary response in memory and lets the person edit or explicitly save it', async () => {
    const create = vi.fn(() => Promise.resolve(null));
    const user = userEvent.setup();
    renderForm(create, 'temporary');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Mood' }), 'Good');
    await user.click(screen.getByRole('button', { name: 'Show results' }));
    expect(screen.getByRole('heading', { name: 'Results ready' })).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Edit answers' }));
    expect(screen.getByRole('combobox', { name: 'Mood' })).toHaveValue('Good');
    await user.click(screen.getByRole('checkbox', { name: 'Save this response' }));
    await user.click(screen.getByRole('button', { name: 'Send response' }));
    expect(create).toHaveBeenCalledExactlyOnceWith('Good', { mood: 'Good' });
  });
  it('navigates visible pages, enforces their required fields, and creates schema-backed properties', async () => {
    const create = vi.fn(() => Promise.resolve(null));
    const user = userEvent.setup();
    renderForm(create);

    expect(screen.getByRole('combobox', { name: 'Mood' })).toBeRequired();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Mood' }), 'Low');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: 'Tell us more' }).closest('header')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Send response' }));
    expect(screen.getByText('This answer is required.')).toBeInTheDocument();

    const detail = screen.getByRole('textbox', { name: 'What happened?' });
    await vi.waitFor(() => {
      expect(detail).toHaveFocus();
    });
    await user.type(detail, 'A difficult morning');
    fireEvent.blur(detail);
    await user.click(screen.getByRole('button', { name: 'Send response' }));

    expect(await screen.findByText('Recorded')).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith('Low', { mood: 'Low', detail: 'A difficult morning' });
  });

  it('does not send two responses when Send response is tapped twice before the first answer returns', async () => {
    const resolvers: ((value: string | null) => void)[] = [];
    const create = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const user = userEvent.setup();
    renderForm(create);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Mood' }), 'Good');

    const button = screen.getByRole('button', { name: 'Send response' });
    // Both taps land before `container.create` has any chance to answer - exactly the double-tap
    // this guards against. `aria-disabled` alone does not stop a second click from reaching the
    // handler, so the guard inside `finish` is what has to hold.
    fireEvent.click(button);
    fireEvent.click(button);

    expect(create).toHaveBeenCalledTimes(1);

    resolvers[0]?.(null);
    expect(await screen.findByText('Recorded')).toBeInTheDocument();
  });

  it('does not require or submit fields hidden by conditions', async () => {
    const create = vi.fn(() => Promise.resolve(null));
    const user = userEvent.setup();
    renderForm(create);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Mood' }), 'Good');
    await user.click(screen.getByRole('button', { name: 'Send response' }));

    expect(create).toHaveBeenCalledWith('Good', { mood: 'Good' });
  });

  it('keeps answers and allows another attempt after the connection fails', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(null);
    const user = userEvent.setup();
    renderForm(create);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Mood' }), 'Good');
    await user.click(screen.getByRole('button', { name: 'Send response' }));

    expect(await screen.findByText(/Check the connection and try again/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Mood' })).toHaveValue('Good');
    expect(screen.getByRole('button', { name: 'Send response' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Send response' }));
    expect(await screen.findByText('Recorded')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(2);
  });
});
