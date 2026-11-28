import { createNixClient, type NixClient } from '@nix/api-client';
import { nixEditingExtensions } from '@nix/editor-schema';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { Editor } from '@tiptap/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInlineAi } from '../../editor/inline-ai/use-inline-ai';
import { InlineAiPanel } from '../../editor/inline-ai/inline-ai-panel';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const petId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const contextRead = vi.hoisted(() => vi.fn(() => 'Nearby synthetic context.'));
let client: NixClient;
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('@nix/web-platform/api/use-pet-settings', () => ({
  usePetSettings: () => ({
    saved: { settings: { enabled: true, inlineWriting: true, activePetId: petId } },
  }),
}));
vi.mock('../../editor/inline-ai/inline-ai-material', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  contextFor: contextRead,
}));
let editor: Editor;
beforeEach(() => {
  contextRead.mockClear();
  editor = new Editor({
    extensions: [...nixEditingExtensions],
    content: '<p>Keep these selected words.</p>',
  });
  editor.commands.setTextSelection({ from: 1, to: 11 });
});
afterEach(() => {
  editor.destroy();
});

function setup() {
  const calls: { path: string; body: unknown }[] = [];
  client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: async (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      const body: unknown =
        typeof init?.body === 'string' ? await new Response(init.body).json() : undefined;
      calls.push({ path, body });
      return new Response('event: done\ndata: {"text":"Prepared writing result."}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  function Writing() {
    const control = useInlineAi({ editor, workspaceId, itemId });
    return (
      <>
        <button
          onClick={() => {
            control.start('custom');
          }}
        >
          Choose writing command
        </button>
        <InlineAiPanel editor={editor} controller={control} />
      </>
    );
  }
  render(
    <MemoryRouter>
      <Writing />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

it('reads inline context and streams the result with no sharing prompt', async () => {
  const { calls, user } = setup();
  await user.click(screen.getByRole('button', { name: 'Choose writing command' }));
  await user.type(
    screen.getByRole('textbox', { name: 'What should the AI write?' }),
    'Rewrite this carefully.',
  );
  await user.click(screen.getByRole('button', { name: 'Generate' }));
  expect(await screen.findByRole('region', { name: 'AI writing result' })).toHaveTextContent(
    'Prepared writing result.',
  );
  expect(contextRead).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toMatchObject({
    workspaceId,
    itemId,
    instruction: 'Rewrite this carefully.',
    context: 'Nearby synthetic context.',
  });
  expect(editor.getText()).toBe('Keep these selected words.');
});
