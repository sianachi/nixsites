import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Editor, LongReply, Reader, Streaming } from '../../../pets/chat/chat-view.stories';

describe('saved conversation notes', () => {
  it('shows persisted messages and a composer when Core permits sending', async () => {
    render(Editor.render());
    expect(await screen.findByText(/Research and planning share a priority/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change sources' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save insight as note' })).toBeVisible();
  });
  it('keeps the transcript readable without exposing editor controls to a reader', async () => {
    render(Reader.render());
    expect(await screen.findByText(/Research and planning share a priority/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change sources' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });
  it('anchors the viewport on the streaming reply, not the saved message before it', async () => {
    render(Streaming.render());
    await screen.findByText(/Drafting the plan/);
    const anchors = document.querySelectorAll('[data-pet-latest-message]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.tagName).toBe('ARTICLE');
  });
  it('previews the complete long reply when saving an insight', async () => {
    render(LongReply.render());
    const save = await screen.findByRole('button', { name: 'Save insight as note' });
    fireEvent.click(save);
    expect(await screen.findByRole('textbox', { name: 'Insight content' })).toHaveValue(
      'a'.repeat(6000) + ' Final conclusion.',
    );
  });
  it('names the workspaces each reply was answered from', async () => {
    render(Editor.render());
    expect(await screen.findByText('Answered from Research')).toBeVisible();
  });
  it('opens the save form under the reply it keeps, with a destination already chosen', async () => {
    render(Editor.render());
    fireEvent.click(await screen.findByRole('button', { name: 'Save insight as note' }));
    const form = await screen.findByRole('region', { name: 'Save insight as note' });
    expect(form.closest('article')).not.toBeNull();
    expect(
      await screen.findByRole('combobox', { name: 'Insight destination workspace' }),
    ).toHaveValue('11111111-1111-4111-8111-111111111111');
    expect(await screen.findByRole('button', { name: 'Save to Research' })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I confirm this destination and its sharing' }),
    );
    expect(screen.getByRole('button', { name: 'Save to Research' })).toBeEnabled();
  });
});
