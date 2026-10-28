import { createNixClient } from '@nix/api-client';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '../../../api/api-client-provider';
import type {
  InteractiveFormDefinition,
  PropertyDefinition,
} from '../../../views/core/container-model';
import {
  EMPTY_INTERACTIVE_FORM,
  InteractiveFormEditor,
  InteractiveFormRespondentPreview,
} from '../../../views/form/interactive-form-editor';
import { renderAt } from '../../render-with-router';
import { useChoiceOrderPreference } from '../../../lib/suggestion-preferences';
import { memoryStorage } from '../../memory-storage';

vi.mock('../../../workspaces/workspace-context', () => ({
  useOptionalWorkspace: () => ({ workspaceId: 'preview-workspace' }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const SCHEMA: readonly PropertyDefinition[] = [
  { key: 'response', label: 'Response', type: 'text', options: [], required: false },
];
const FORM: InteractiveFormDefinition = {
  ...EMPTY_INTERACTIVE_FORM,
  pages: [
    {
      id: 'first',
      title: 'Your response',
      description: null,
      visibleWhen: [],
      blocks: [
        {
          id: 'response',
          kind: 'field',
          propertyKey: 'response',
          text: 'Your next step',
          help: null,
          required: true,
          identityRole: null,
          visibleWhen: [],
        },
      ],
    },
  ],
};

describe('interactive form design', () => {
  it('does not record choice history while previewing the form in a workspace', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    useChoiceOrderPreference.getState().setSetting('on');
    renderAt(
      <InteractiveFormRespondentPreview
        form={FORM}
        schema={[
          {
            key: 'response',
            label: 'Response',
            type: 'select',
            options: ['Good', 'Low'],
            required: false,
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Your next step' }), {
      target: { value: 'Good' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview confirmation' }));
    expect(screen.getByRole('heading', { name: 'Response received' })).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });
  it('focuses the required answer in the respondent preview and clears its error when answered', async () => {
    const user = userEvent.setup();
    renderAt(<InteractiveFormRespondentPreview form={FORM} schema={SCHEMA} />);
    await user.click(screen.getByRole('button', { name: 'Preview confirmation' }));
    const answer = screen.getByRole('textbox', { name: 'Your next step' });
    await vi.waitFor(() => {
      expect(answer).toHaveFocus();
    });
    expect(screen.getByText('This answer is required.')).toBeInTheDocument();
    await user.type(answer, 'Take a walk');
    fireEvent.blur(answer);
    expect(screen.queryByText('This answer is required.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview confirmation' }));
    expect(screen.getByRole('heading', { name: 'Response received' })).toBeInTheDocument();
  });

  it('offers manual copying when clipboard access is refused', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              published: true,
              url: 'https://nix.test/forms/link',
              publishedAt: null,
              revokedAt: null,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );
    const client = createNixClient({
      baseUrl: 'https://nix.test',
      tokens: {
        getAccessToken: () => Promise.resolve('token'),
        refreshAccessToken: () => Promise.resolve('token'),
      },
    });
    renderAt(
      <ApiClientOverrideProvider client={client}>
        <InteractiveFormEditor
          form={FORM}
          schema={SCHEMA}
          itemId="container"
          viewId="form"
          onChange={() => undefined}
        />
      </ApiClientOverrideProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenCalledWith('https://nix.test/forms/link');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Select and copy it from the field',
    );
    expect(screen.getByRole('textbox', { name: 'Public form URL' })).toHaveValue(
      'https://nix.test/forms/link',
    );
  });
});
