import { act, renderHook } from '@testing-library/react';
import { UndoProvider, useUndo } from '@nix/ui';
import { type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { petConnectionSchema } from '@nix/api-client';
import { useRename } from '../../pets/conversation/state/use-rename';
import { useResumeUndo } from '../../pets/conversation/state/use-resume-undo';

const execute = vi.fn();
vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => ({ execute }),
}));

const W = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';
const connection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: '',
  canConnect: false,
  history: [{ id: OLD, title: 'Plan', createdAt: '2026-09-06T12:00:00Z' }],
});
const wrapper = ({ children }: { children: ReactNode }) => <UndoProvider>{children}</UndoProvider>;

it('undoes a rename by renaming back to the previous title', async () => {
  execute.mockReset().mockResolvedValue(connection);
  const setRuntime = vi.fn();
  const { result } = renderHook(
    () => ({
      rename: useRename({
        workspaceId: W,
        petId: P,
        rootItemId: undefined,
        currentTitle: 'Plan',
        setRuntime,
      }),
      undo: useUndo(),
    }),
    { wrapper },
  );
  await act(() => result.current.rename.renameConversation('Weekly plan'));
  expect(result.current.undo.depth).toBe(1);
  await act(() => result.current.undo.undoLatest());
  expect(execute.mock.calls[1]?.[0]).toMatchObject({ body: { operation: 'rename', text: 'Plan' } });
  expect(result.current.undo.depth).toBe(0);
});

it('does not offer undo for a rename of an untitled conversation', async () => {
  execute.mockReset().mockResolvedValue(connection);
  const { result } = renderHook(
    () => ({
      rename: useRename({
        workspaceId: W,
        petId: P,
        rootItemId: undefined,
        currentTitle: '',
        setRuntime: vi.fn(),
      }),
      undo: useUndo(),
    }),
    { wrapper },
  );
  await act(() => result.current.rename.renameConversation('First'));
  expect(result.current.undo.depth).toBe(0);
});

it('undoes a swap by continuing the newest archived conversation, and only if one was archived', async () => {
  execute.mockReset().mockResolvedValue(connection);
  const setRuntime = vi.fn();
  const { result } = renderHook(
    () => ({
      arm: useResumeUndo({ workspaceId: W, petId: P, rootItemId: undefined, setRuntime }),
      undo: useUndo(),
    }),
    { wrapper },
  );
  act(() => {
    result.current.arm('Started a new conversation', false);
  });
  expect(result.current.undo.depth).toBe(0);
  act(() => {
    result.current.arm('Started a new conversation', true);
  });
  await act(() => result.current.undo.undoLatest());
  expect(execute.mock.calls[1]?.[0]).toMatchObject({
    body: { operation: 'resume_history', historyId: OLD },
  });
  expect(setRuntime).toHaveBeenCalledTimes(1);
});
