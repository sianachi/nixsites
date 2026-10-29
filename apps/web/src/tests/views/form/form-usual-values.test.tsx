import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aContainer } from '../../container-fixture';
import { aView } from '../../view-fixture';
import { FormView } from '../../../views/form/form-view';
import { rememberSubmission } from '../../../views/form/form-memory';
import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { useChoiceOrderPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { CATEGORY } from '../suggest/suggest-fixtures';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

/**
 * The form's usual values: offered beside an empty field from this person's own earlier
 * submissions, never filled in by themselves, and recorded only when a submission succeeds.
 */

const WORKSPACE = 'dddddddd-4444-4444-8444-dddddddddddd';

vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
  useOptionalWorkspace: () => ({ workspaceId: WORKSPACE }),
}));

const VIEW = aView({ id: 'intake', kind: 'form', columns: ['category'] });

function renderForm(
  create = vi.fn((): Promise<string | null> => Promise.resolve(null)),
  view = VIEW,
) {
  renderAt(
    <FormView
      container={aContainer({
        schema: { properties: [CATEGORY], declared: [CATEGORY], inherit: true },
        create,
      })}
      view={view}
      onOpen={vi.fn()}
    />,
  );
  return create;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  useViewSuggestionPreference.getState().setSetting('on');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usual values in a form', () => {
  it('does not record a temporary response in form memory or independent choice history', async () => {
    useChoiceOrderPreference.getState().setSetting('on');
    const create = renderForm(undefined, { ...VIEW, mode: 'temporary' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), {
      target: { value: 'Bills' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    expect(await screen.findByText('Calculated here. No entry was saved.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('offers nothing when suggestions in views are switched off', () => {
    rememberSubmission(WORKSPACE, 'intake', [CATEGORY], { category: 'Bills' });
    rememberSubmission(WORKSPACE, 'intake', [CATEGORY], { category: 'Bills' });
    useViewSuggestionPreference.getState().setSetting('off');
    renderForm();

    expect(screen.queryByText(/Your usual Category/)).not.toBeInTheDocument();
  });

  it('offers the usual value without filling it in', async () => {
    rememberSubmission(WORKSPACE, 'intake', [CATEGORY], { category: 'Bills' });
    rememberSubmission(WORKSPACE, 'intake', [CATEGORY], { category: 'Bills' });
    const create = renderForm();

    expect(screen.getByText(/Your usual Category/)).toHaveTextContent('Your usual Category: Bills');
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('');

    fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), { target: { value: 'Rent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith('Rent', {});
    });
  });

  it('fills the field when the person uses it', async () => {
    rememberSubmission(WORKSPACE, 'intake', [CATEGORY], { category: 'Bills' });
    rememberSubmission(WORKSPACE, 'intake', [CATEGORY], { category: 'Bills' });
    const create = renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Use Bills for Category' }));
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Bills');

    fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), { target: { value: 'Rent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith('Rent', { category: 'Bills' });
    });
  });

  it('learns from successful submissions and offers the habit afterwards', async () => {
    renderForm();
    expect(screen.queryByText(/Your usual/)).not.toBeInTheDocument();

    for (const title of ['Rent', 'Water']) {
      fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), {
        target: { value: 'Bills' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), {
        target: { value: title },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
      await screen.findByText('Entry added.');
    }

    expect(await screen.findByText(/Your usual Category/)).toHaveTextContent('Bills');
  });

  it('remembers nothing from a refused submission', async () => {
    renderForm(vi.fn(() => Promise.resolve('Refused.')));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), {
        target: { value: 'Bills' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), {
        target: { value: 'Rent' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
      await screen.findByText('Refused.');
    }
    expect(screen.queryByText(/Your usual/)).not.toBeInTheDocument();
  });
});
