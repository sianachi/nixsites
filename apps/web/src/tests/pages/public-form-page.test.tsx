import { createNixClient } from '@nix/api-client';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import type { PublicForm } from '../../pages/public-form-api';
import { PublicFormPage } from '../../pages/public-form-page';
import { setZenMode } from '@nix/web-foundation/lib/zen-mode';
import { renderAt } from '@nix/web-editor/testing/render-with-router';

const FORM: PublicForm = {
  name: 'Daily check in',
  form: {
    pages: [
      {
        id: 'first',
        title: 'Your response',
        description: null,
        visibleWhen: [],
        blocks: [
          {
            id: 'answer',
            kind: 'field',
            text: 'How was today?',
            help: null,
            required: true,
            identityRole: null,
            visibleWhen: [],
          },
        ],
      },
    ],
    confirmationTitle: 'Response received',
    confirmationMessage: 'Thanks for checking in.',
  },
  fields: [{ blockId: 'answer', type: 'text', options: [] }],
};

function renderForm(submit: () => Promise<Response>, definition: PublicForm = FORM): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? submit()
        : Promise.resolve(
            new Response(JSON.stringify(definition), {
              headers: { 'content-type': 'application/json' },
            }),
          ),
    ),
  );
  const client = createNixClient({
    baseUrl: 'http://localhost',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  renderAt(
    <ApiClientOverrideProvider client={client}>
      <Routes>
        <Route path="/forms/:token" element={<PublicFormPage />} />
      </Routes>
    </ApiClientOverrideProvider>,
    '/forms/public-token',
  );
}

async function fillAnswer(): Promise<void> {
  const user = userEvent.setup();
  const answer = await screen.findByRole('textbox', { name: 'How was today?' });
  await user.type(answer, 'A good day');
  fireEvent.blur(answer);
}

beforeEach(() => {
  setZenMode(false);
});

describe('public form responses', () => {
  it('keeps answers and submission controls when entering and leaving Zen', async () => {
    const submit = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const user = userEvent.setup();
    renderForm(submit);
    await fillAnswer();
    await user.click(screen.getByRole('button', { name: 'Enter Zen' }));
    expect(screen.getByRole('button', { name: 'Exit Zen' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('form', { name: 'Daily check in' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your response' })).toHaveClass('sr-only');
    expect(screen.getByRole('textbox', { name: 'How was today?' })).toHaveValue('A good day');
    expect(screen.getByRole('button', { name: 'Send response' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Exit Zen' }));
    expect(screen.getByRole('heading', { name: 'Your response' })).not.toHaveClass('sr-only');
    expect(screen.getByRole('textbox', { name: 'How was today?' })).toHaveValue('A good day');
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not submit an invalid URL despite custom required-field validation', async () => {
    const submit = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const user = userEvent.setup();
    renderForm(submit, { ...FORM, fields: [{ blockId: 'answer', type: 'url', options: [] }] });
    const answer = await screen.findByRole('textbox', { name: 'How was today?' });
    await user.type(answer, 'invalid address');
    await user.click(screen.getByRole('button', { name: 'Send response' }));
    expect(answer).toBeInvalid();
    expect(answer).toHaveFocus();
    expect(submit).not.toHaveBeenCalled();
  });

  it('announces required errors and focuses the missing answer', async () => {
    const submit = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const user = userEvent.setup();
    renderForm(submit);
    const answer = await screen.findByRole('textbox', { name: 'How was today?' });
    expect(answer).toBeRequired();
    await user.click(screen.getByRole('button', { name: 'Send response' }));
    expect(screen.getByText('This answer is required.')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(answer).toHaveFocus();
    });
    expect(submit).not.toHaveBeenCalled();

    await fillAnswer();
    expect(screen.queryByText('This answer is required.')).not.toBeInTheDocument();
  });

  it('preserves answers after a failed submission and retries', async () => {
    const submit = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'unavailable', detail: 'Connection interrupted' }), {
          status: 503,
          headers: { 'content-type': 'application/problem+json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    renderForm(submit);
    await fillAnswer();
    await user.click(screen.getByRole('button', { name: 'Send response' }));
    expect(await screen.findByText('Connection interrupted')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'How was today?' })).toHaveValue('A good day');
    await user.click(screen.getByRole('button', { name: 'Send response' }));
    expect(await screen.findByRole('heading', { name: 'Response received' })).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('sends only once when a respondent taps again while waiting', async () => {
    const pending: { finish?: (response: Response) => void } = {};
    const submit = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.finish = resolve;
        }),
    );
    renderForm(submit);
    await fillAnswer();
    const form = screen.getByRole('form', { name: 'Daily check in' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    pending.finish?.(new Response(null, { status: 204 }));
    expect(await screen.findByRole('heading', { name: 'Response received' })).toBeInTheDocument();
  });
});
