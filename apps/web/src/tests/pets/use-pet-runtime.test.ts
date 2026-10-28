import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NixApiError, petConnectionSchema, type PetConnection } from '@nix/api-client';
import { usePetRuntime } from '../../pets/use-pet-runtime';

const client = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const PET_ID = '22222222-2222-4222-8222-222222222222';

function connection(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'chatgpt',
    status: 'connected',
    reason: '',
    canConnect: false,
    verificationUrl: '',
    userCode: '',
    state: 'idle',
    messages: [],
    history: [],
    models: [],
    tools: [],
    revision: 0,
    lockedRead: false,
    title: '',
    ...overrides,
  };
}

function watchQuery(call: unknown): { workspaceId: string; petId: string; after: number } {
  return (call as { query: { workspaceId: string; petId: string; after: number } }).query;
}

describe('usePetRuntime watch loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    client.query.mockReset();
    client.execute.mockReset();
    client.execute.mockResolvedValue(connection());
    document.dispatchEvent(new Event('visibilitychange'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts the first watch at after: 0, then advances after as the revision grows', async () => {
    client.query
      .mockResolvedValueOnce(connection({ revision: 1 }))
      .mockResolvedValue(connection({ revision: 1 }));
    renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(watchQuery(client.query.mock.calls[0]?.[0]).after).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    const laterCall: unknown = client.query.mock.calls.at(-1)?.[0];
    expect(watchQuery(laterCall).after).toBe(1);
  });

  it('discovers models for the selected pet instead of the account default', async () => {
    client.query.mockResolvedValue(connection());
    renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.execute.mock.calls[0]?.[0]).toHaveProperty('body.operation', 'models');
    expect(client.execute.mock.calls[0]?.[0]).toHaveProperty('body.workspaceId', WORKSPACE_ID);
    expect(client.execute.mock.calls[0]?.[0]).toHaveProperty('body.petId', PET_ID);
  });

  it('clears model discovery from the previous pet while the new request is pending', async () => {
    client.query.mockResolvedValue(connection());
    client.execute
      .mockResolvedValueOnce(connection({ models: [{ id: 'gpt-model', name: 'GPT model' }] }))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const { result, rerender } = renderHook(
      ({ petId }: { petId: string }) => usePetRuntime(WORKSPACE_ID, petId, true),
      { initialProps: { petId: PET_ID } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.models.map((model) => model.id)).toEqual(['gpt-model']);
    rerender({ petId: '99999999-9999-4999-8999-999999999999' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.models).toEqual([]);
    expect(client.execute.mock.calls.at(-1)?.[0]).toHaveProperty(
      'body.petId',
      '99999999-9999-4999-8999-999999999999',
    );
  });

  it('applies a newer revision but ignores a stale one that arrives after it', async () => {
    client.query
      .mockResolvedValueOnce(connection({ revision: 3, reason: 'third' }))
      .mockResolvedValueOnce(connection({ revision: 2, reason: 'stale-second' }))
      .mockResolvedValue(connection({ revision: 3, reason: 'third' }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.runtime?.revision).toBe(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    // The stale (lower) revision returned by the second call must never overwrite the newer
    // state already applied from the first.
    expect(result.current.runtime?.revision).toBe(3);
    expect(result.current.runtime?.reason).toBe('third');
  });

  it.each(['anthropic', 'openrouter'])(
    'accepts %s setup after an established conversation and rejects its late responses',
    async (provider) => {
      const connected = connection({ provider, revision: 10 });
      const setup = connection({
        provider,
        status: 'disconnected',
        revision: 0,
        reason: 'Add an API key in Pet settings.',
      });
      client.query
        .mockResolvedValueOnce(connected)
        .mockResolvedValueOnce(setup)
        .mockResolvedValue(connection({ provider, revision: 1, reason: 'Reconnected' }));
      client.execute
        .mockResolvedValueOnce(connection({ models: [{ id: 'old-model', name: 'Old model' }] }))
        .mockResolvedValue(connection({ models: [{ id: 'new-model', name: 'New model' }] }));
      const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.runtime?.status).toBe('connected');
      const staleSetRuntime = result.current.setRuntime;
      let finishCommand: ((value: PetConnection) => void) | undefined;
      client.execute.mockImplementationOnce(
        () =>
          new Promise<PetConnection>((resolve) => {
            finishCommand = resolve;
          }),
      );
      let pendingCommand: Promise<void> | undefined;
      act(() => {
        pendingCommand = result.current.reload();
      });
      expect(result.current.busy).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(result.current.runtime?.status).toBe('disconnected');
      expect(result.current.runtime?.reason).toBe('Add an API key in Pet settings.');
      expect(result.current.models).toEqual([]);
      expect(result.current.busy).toBe(false);
      await act(async () => {
        const stale = petConnectionSchema.parse({
          ...connected,
          revision: 99,
          reason: 'Stale connected response',
        });
        staleSetRuntime(stale);
        finishCommand?.(stale);
        await pendingCommand;
      });
      expect(result.current.runtime?.status).toBe('disconnected');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(watchQuery(client.query.mock.calls.at(-1)?.[0]).after).toBe(0);
      expect(result.current.runtime?.reason).toBe('Reconnected');
      expect(result.current.runtime?.revision).toBe(1);
      expect(result.current.models.map((model) => model.id)).toEqual(['new-model']);
    },
  );

  it('discovers models once when a previously keyless provider connects', async () => {
    const setup = connection({ provider: 'anthropic', status: 'disconnected' });
    client.query
      .mockResolvedValueOnce(setup)
      .mockResolvedValue(connection({ provider: 'anthropic', revision: 1 }));
    client.execute
      .mockResolvedValueOnce(setup)
      .mockResolvedValue(connection({ models: [{ id: 'claude-model', name: 'Claude model' }] }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.models).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1250);
    });
    expect(result.current.models.map((model) => model.id)).toEqual(['claude-model']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(client.execute).toHaveBeenCalledTimes(2);
  });

  it('refreshes a replacement key while a watch is pending without accepting older models', async () => {
    let finishModels: ((value: unknown) => void) | undefined;
    const connected = connection({ provider: 'anthropic', revision: 10 });
    client.query
      .mockResolvedValueOnce(connected)
      .mockImplementation(() => new Promise<never>(() => undefined));
    client.execute
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishModels = resolve;
          }),
      )
      .mockResolvedValueOnce(connected)
      .mockResolvedValueOnce(connection({ models: [{ id: 'new-model', name: 'New model' }] }));
    const { result, unmount } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(client.query).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.execute.mock.calls[1]?.[0]).toHaveProperty('body.operation', 'read');
    expect(client.execute.mock.calls[1]?.[0]).toHaveProperty('body.petId', PET_ID);
    expect(client.execute.mock.calls[1]?.[0]).toHaveProperty('body.workspaceId', WORKSPACE_ID);
    expect(result.current.models.map((model) => model.id)).toEqual(['new-model']);
    await act(async () => {
      finishModels?.(connection({ models: [{ id: 'old-model', name: 'Old model' }] }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.models.map((model) => model.id)).toEqual(['new-model']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(client.execute).toHaveBeenCalledTimes(3);
    unmount();
    window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
    expect(client.execute).toHaveBeenCalledTimes(3);
  });

  it('shows key removal immediately and drops the older watch before reconnecting', async () => {
    const connected = connection({ provider: 'anthropic', revision: 10 });
    let finishWatch: ((value: unknown) => void) | undefined;
    client.query
      .mockResolvedValueOnce(connected)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishWatch = resolve;
          }),
      )
      .mockResolvedValue(connection({ provider: 'anthropic', revision: 1, reason: 'Reconnected' }));
    client.execute
      .mockResolvedValueOnce(connection({ models: [{ id: 'old-model', name: 'Old model' }] }))
      .mockResolvedValueOnce(
        connection({
          provider: 'anthropic',
          status: 'disconnected',
          revision: 0,
          reason: 'Add a Claude API key in Pet settings.',
        }),
      )
      .mockResolvedValue(connection({ models: [{ id: 'new-model', name: 'New model' }] }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => {
      window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.runtime?.status).toBe('disconnected');
    expect(result.current.runtime?.reason).toBe('Add a Claude API key in Pet settings.');
    expect(result.current.models).toEqual([]);
    await act(async () => {
      finishWatch?.(connection({ provider: 'anthropic', revision: 11, reason: 'Old watch' }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.runtime?.status).toBe('disconnected');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(watchQuery(client.query.mock.calls.at(-1)?.[0]).after).toBe(0);
    expect(result.current.runtime?.reason).toBe('Reconnected');
    expect(result.current.models.map((model) => model.id)).toEqual(['new-model']);
  });

  it('keeps a saved replacement connected when an older removal read finishes with the panel closed', async () => {
    const connected = connection({ provider: 'anthropic', revision: 10 });
    let finishRemoval: ((value: unknown) => void) | undefined;
    let finishReplacement: ((value: unknown) => void) | undefined;
    client.query.mockResolvedValue(connected);
    client.execute
      .mockResolvedValueOnce(connection({ models: [{ id: 'old-model', name: 'Old model' }] }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRemoval = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishReplacement = resolve;
          }),
      )
      .mockResolvedValue(connection({ models: [{ id: 'new-model', name: 'New model' }] }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const staleSetRuntime = result.current.setRuntime;
    act(() => {
      window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
      window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
    });
    await act(async () => {
      finishReplacement?.({ ...connected, reason: 'Replacement saved' });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.runtime?.reason).toBe('Replacement saved');
    expect(result.current.models.map((model) => model.id)).toEqual(['new-model']);
    await act(async () => {
      finishRemoval?.(connection({ provider: 'anthropic', status: 'disconnected', revision: 0 }));
      staleSetRuntime(
        petConnectionSchema.parse({ ...connected, revision: 99, reason: 'Stale tool' }),
      );
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.runtime?.status).toBe('connected');
    expect(result.current.runtime?.reason).toBe('Replacement saved');
    expect(result.current.models.map((model) => model.id)).toEqual(['new-model']);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.execute).toHaveBeenCalledTimes(4);
    act(() => {
      result.current.setRuntime(
        petConnectionSchema.parse({ ...connected, revision: 11, reason: 'Current tool' }),
      );
    });
    expect(result.current.runtime?.reason).toBe('Current tool');
  });

  it('ignores an older keyless watch after a key event connects an initially closed panel', async () => {
    let finishWatch: ((value: unknown) => void) | undefined;
    client.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWatch = resolve;
        }),
    );
    client.execute
      .mockResolvedValueOnce(connection({ provider: 'anthropic', status: 'disconnected' }))
      .mockResolvedValueOnce(
        connection({ provider: 'anthropic', revision: 10, reason: 'Key saved' }),
      )
      .mockResolvedValue(connection({ models: [{ id: 'new-model', name: 'New model' }] }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.runtime?.reason).toBe('Key saved');
    expect(result.current.models.map((model) => model.id)).toEqual(['new-model']);
    await act(async () => {
      finishWatch?.(connection({ provider: 'anthropic', status: 'disconnected', revision: 0 }));
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.runtime?.status).toBe('connected');
    expect(result.current.runtime?.reason).toBe('Key saved');
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.execute).toHaveBeenCalledTimes(3);
    act(() => {
      result.current.setRuntime(
        petConnectionSchema.parse({
          provider: 'anthropic',
          revision: 11,
          status: 'connected',
          reason: 'Current tool',
          canConnect: false,
        }),
      );
    });
    expect(result.current.runtime?.reason).toBe('Current tool');
  });

  it('keeps the new tool generation when a key event arrives before initial state is published', async () => {
    const connected = connection({ provider: 'anthropic', revision: 10 });
    client.query.mockResolvedValue(connected);
    client.execute
      .mockResolvedValueOnce(connection({ provider: 'anthropic', status: 'disconnected' }))
      .mockResolvedValueOnce(connected)
      .mockResolvedValue(connection({ models: [{ id: 'new-model', name: 'New model' }] }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, false));
    await act(async () => {
      window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.models.map((model) => model.id)).toEqual(['new-model']);
    act(() => {
      result.current.setRuntime(
        petConnectionSchema.parse({ ...connected, revision: 11, reason: 'Current tool' }),
      );
    });
    expect(result.current.runtime?.reason).toBe('Current tool');
    expect(client.execute).toHaveBeenCalledTimes(3);
  });

  it('backs off 1s, 2s, 4s, then caps at 10s after consecutive watch failures', async () => {
    client.query.mockRejectedValue(new Error('network down'));
    renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(1); // failure #1, no backoff owed yet

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(client.query).toHaveBeenCalledTimes(1); // still within the 1s backoff after failure #1
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.query).toHaveBeenCalledTimes(2); // failure #2 fires exactly at the 1s mark

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(client.query).toHaveBeenCalledTimes(2); // within the 2s backoff after failure #2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.query).toHaveBeenCalledTimes(3); // failure #3 fires exactly at the 2s mark

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3999);
    });
    expect(client.query).toHaveBeenCalledTimes(3); // within the 4s backoff after failure #3
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.query).toHaveBeenCalledTimes(4); // failure #4 fires exactly at the 4s mark, backoff caps at 10s

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9999);
    });
    expect(client.query).toHaveBeenCalledTimes(4); // within the capped 10s backoff after failure #4
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.query).toHaveBeenCalledTimes(5); // failure #5 fires exactly at the 10s cap
  });

  it('shows the load error only after two consecutive failures', async () => {
    client.query.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(result.current.error).toContain('could not be loaded');
  });

  it('pauses while the document is hidden and resumes immediately once visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    client.query.mockResolvedValue(connection({ revision: 1 }));
    renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.query).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('stops watching once a closed panel has settled and is idle', async () => {
    client.query.mockResolvedValue(connection({ revision: 1, state: 'success', tools: [] }));
    renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterSettling = client.query.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // No further network requests - only the local `IDLE_RECHECK_MS` check, which issues none.
    expect(client.query.mock.calls.length).toBe(callsAfterSettling);
  });

  it('aborts the in-flight watch on unmount, so a late response is never applied', async () => {
    client.query.mockResolvedValue(connection({ revision: 1 }));
    const { unmount } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsBeforeUnmount = client.query.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.query.mock.calls.length).toBe(callsBeforeUnmount);
  });
});

describe('usePetRuntime errorKind and retryWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    client.query.mockReset();
    client.execute.mockReset();
    client.execute.mockResolvedValue(connection());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('marks a watch failure "load", offering "Retry now" behaviour via retryWatch', async () => {
    client.query.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(result.current.errorKind).toBe('load');
  });

  it('retryWatch wakes the loop immediately, skipping the remaining backoff delay', async () => {
    client.query
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(connection({ revision: 1 }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.retryWatch();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('marks a failed send "send", never a load or command failure', async () => {
    // Never resolves, so this test isolates the send path from the watch loop.
    client.query.mockImplementation(() => new Promise<never>(() => undefined));
    client.execute.mockImplementation((endpoint: unknown) => {
      const operation = (endpoint as { body?: { operation?: string } }).body?.operation;
      if (operation === 'send') return Promise.reject(new Error('boom'));
      return Promise.resolve(connection());
    });
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await result.current.send({ text: 'hi', model: '', workspaceAccess: false });
    });
    expect(result.current.errorKind).toBe('send');
  });

  it('keeps a safe provider credit problem visible and retries the untouched request', async () => {
    const problem = NixApiError.fromProblemDetails(402, {
      code: 'pets.provider_credit_balance',
      detail:
        'Claude reports that this API key has insufficient credit. Check API billing for the key, then try again.',
    });
    client.query.mockResolvedValue(connection({ revision: 1 }));
    client.execute
      .mockResolvedValueOnce(connection())
      .mockRejectedValueOnce(problem)
      .mockResolvedValue(connection({ revision: 2 }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(
        await result.current.send({ text: 'Plan my notes', model: '', workspaceAccess: false }),
      ).toBe(false);
    });
    expect(result.current.error).toBe(
      'Claude reports that this API key has insufficient credit. Check API billing for the key, then try again. Your draft is preserved.',
    );
    expect(result.current.errorKind).toBe('send');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(client.query.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.error).toBe(
      'Claude reports that this API key has insufficient credit. Check API billing for the key, then try again. Your draft is preserved.',
    );
    await act(async () => {
      expect(
        await result.current.send({ text: 'Plan my notes', model: '', workspaceAccess: false }),
      ).toBe(true);
    });
    expect(client.execute.mock.calls[2]?.[0]).toEqual(client.execute.mock.calls[1]?.[0]);
  });

  it.each([
    { name: 'plain error', cause: new Error('Internal request diagnostics') },
    {
      name: 'network failure',
      cause: NixApiError.network(new Error('Internal request diagnostics')),
    },
    { name: 'response validation', cause: NixApiError.responseValidation('pets.runtime', [], 200) },
    {
      name: 'unstructured HTTP',
      cause: NixApiError.fromStatus(502, 'Internal request diagnostics'),
    },
    {
      name: 'other Core problem',
      cause: NixApiError.fromProblemDetails(500, {
        code: 'internal.error',
        detail: 'Internal request diagnostics',
      }),
    },
    {
      name: 'empty pet problem',
      cause: NixApiError.fromProblemDetails(503, { code: 'pets.unavailable', detail: '   ' }),
    },
  ])('keeps the generic send copy for $name', async ({ cause }) => {
    client.query.mockResolvedValue(connection());
    client.execute.mockResolvedValueOnce(connection()).mockRejectedValueOnce(cause);
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(
        await result.current.send({ text: 'Plan my notes', model: '', workspaceAccess: false }),
      ).toBe(false);
    });
    expect(result.current.error).toBe(
      'The request could not be confirmed. Try again; your draft is preserved.',
    );
    expect(result.current.errorKind).toBe('send');
  });

  it.each(['reload', 'key event'])(
    'recovers provider model discovery through one %s',
    async (recovery) => {
      const problem = NixApiError.fromProblemDetails(400, {
        code: 'pets.provider_models_rejected',
        detail:
          'Claude rejected model discovery for this API key. Check its API access and billing, then try again.',
      });
      client.query.mockResolvedValue(connection({ provider: 'anthropic', revision: 10 }));
      client.execute
        .mockRejectedValueOnce(problem)
        .mockResolvedValueOnce(connection({ provider: 'anthropic', revision: 10 }))
        .mockResolvedValue(connection({ models: [{ id: 'claude-model', name: 'Claude model' }] }));
      const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(result.current.error).toBe(
        'Claude rejected model discovery for this API key. Check its API access and billing, then try again.',
      );
      expect(result.current.errorKind).toBe('command');
      expect(client.execute).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (recovery === 'reload') await result.current.reload();
        else window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.models.map((model) => model.id)).toEqual(['claude-model']);
      expect(result.current.error).toBe('');
      expect(result.current.errorKind).toBeNull();
      expect(client.execute.mock.calls[1]?.[0]).toHaveProperty('body.operation', 'read');
      expect(client.execute.mock.calls[2]?.[0]).toHaveProperty('body.operation', 'models');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(client.execute).toHaveBeenCalledTimes(3);
    },
  );

  it('does not discover models twice when reload reconnects a keyless provider', async () => {
    const setup = connection({ provider: 'anthropic', status: 'disconnected' });
    const connected = connection({ provider: 'anthropic', revision: 1 });
    client.query.mockResolvedValueOnce(setup).mockResolvedValue(connected);
    client.execute
      .mockResolvedValueOnce(setup)
      .mockResolvedValueOnce(connected)
      .mockResolvedValue(connection({ models: [{ id: 'claude-model', name: 'Claude model' }] }));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await result.current.reload();
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.models.map((model) => model.id)).toEqual(['claude-model']);
    expect(client.execute).toHaveBeenCalledTimes(3);
  });

  it('does not overwrite a send error with a later provider discovery failure', async () => {
    let refuseModels: ((cause: unknown) => void) | undefined;
    client.query.mockResolvedValue(connection({ revision: 1 }));
    client.execute
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            refuseModels = reject;
          }),
      )
      .mockRejectedValueOnce(
        NixApiError.fromProblemDetails(402, {
          code: 'pets.provider_credit_balance',
          detail: 'Claude reports insufficient credit.',
        }),
      );
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await result.current.send({ text: 'Plan my notes', model: '', workspaceAccess: false });
      refuseModels?.(
        NixApiError.fromProblemDetails(400, {
          code: 'pets.provider_models_rejected',
          detail: 'Claude rejected model discovery.',
        }),
      );
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.error).toBe(
      'Claude reports insufficient credit. Your draft is preserved.',
    );
    expect(result.current.errorKind).toBe('send');
  });

  it('keeps provider-default behavior for a transient model discovery failure', async () => {
    client.query.mockResolvedValue(connection({ revision: 1 }));
    client.execute.mockRejectedValueOnce(
      NixApiError.network(new Error('Internal request diagnostics')),
    );
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.models).toEqual([]);
    expect(result.current.error).toBe('');
    expect(result.current.errorKind).toBeNull();
    expect(client.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed send visible across later successful watches', async () => {
    client.query.mockResolvedValue(connection({ revision: 1 }));
    client.execute.mockImplementation((endpoint: unknown) => {
      const operation = (endpoint as { body?: { operation?: string } }).body?.operation;
      if (operation === 'send') return Promise.reject(new Error('boom'));
      return Promise.resolve(connection());
    });
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await result.current.send({ text: 'hi', model: '', workspaceAccess: false });
    });
    expect(result.current.errorKind).toBe('send');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(client.query.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.errorKind).toBe('send');
    expect(result.current.error).not.toBe('');
  });

  it('marks a failed one-off command (reload) "command"', async () => {
    // Never resolves - see the send test above for why.
    client.query.mockImplementation(() => new Promise<never>(() => undefined));
    client.execute.mockImplementation((endpoint: unknown) => {
      const operation = (endpoint as { body?: { operation?: string } }).body?.operation;
      if (operation === 'read') return Promise.reject(new Error('boom'));
      return Promise.resolve(connection());
    });
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.errorKind).toBe('command');
  });

  it('keeps the same request id when a failed send is retried unedited', async () => {
    let sendAttempts = 0;
    client.execute.mockImplementation((endpoint: unknown) => {
      const body = (endpoint as { body?: { operation?: string } }).body;
      if (body?.operation === 'send') {
        sendAttempts += 1;
        return sendAttempts === 1
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(connection());
      }
      return Promise.resolve(connection());
    });
    client.query.mockResolvedValue(connection());
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    await act(async () => {
      await result.current.send({ text: 'hi', model: '', workspaceAccess: false });
    });
    await act(async () => {
      await result.current.send({ text: 'hi', model: '', workspaceAccess: false });
    });
    const sendBodies = client.execute.mock.calls
      .map(([endpoint]) => (endpoint as { body?: { operation?: string; requestId?: string } }).body)
      .filter((body) => body?.operation === 'send');
    expect(sendBodies).toHaveLength(2);
    expect(sendBodies[0]?.requestId).toBe(sendBodies[1]?.requestId);
  });

  it("sends the owner's day and zone with every message, and a workspace map only when given", async () => {
    client.query.mockResolvedValue(connection());
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true));
    const map = [{ id: WORKSPACE_ID, title: 'Tasks', type: 'note', viewKinds: ['board'] }];
    await act(async () => {
      await result.current.send({
        text: 'hi',
        model: '',
        workspaceAccess: true,
        workspaceMap: map,
      });
    });
    await act(async () => {
      await result.current.send({ text: 'and then?', model: '', workspaceAccess: true });
    });
    const sendBodies = client.execute.mock.calls
      .map(([endpoint]) => (endpoint as { body?: Record<string, unknown> }).body)
      .filter((body) => body?.operation === 'send');
    expect(sendBodies).toHaveLength(2);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const body of sendBodies) {
      expect(body?.timeZone).toBe(zone);
      expect(body?.today).toMatch(/^2026-10-(08|09|10)$/);
    }
    expect(sendBodies[0]?.workspaceMap).toEqual([{ ...map[0], viewKinds: ['board'] }]);
    expect(sendBodies[1]?.workspaceMap).toBeNull();
  });

  it('ignores a setRuntime call bound to a stale generation once the pet has moved on', async () => {
    client.query.mockResolvedValue(connection());
    const { result, rerender } = renderHook(
      ({ petId }: { petId: string }) => usePetRuntime(WORKSPACE_ID, petId, true),
      { initialProps: { petId: PET_ID } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Captured before the pet switch - the same stale reference a `PetWorkTools` instance's
    // in-flight `tool_result` promise would still be holding once it resolves late.
    const staleSetRuntime = result.current.setRuntime;
    rerender({ petId: '99999999-9999-4999-8999-999999999999' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      staleSetRuntime(connection({ revision: 999, reason: 'stale-pet' }) as PetConnection);
    });
    expect(result.current.runtime?.reason).not.toBe('stale-pet');
  });
  it('keeps watches and commands rooted on the note and sends the chosen access mode', async () => {
    const root = '66666666-6666-4666-8666-666666666666';
    client.query.mockResolvedValue(connection());
    const { result } = renderHook(() => usePetRuntime(WORKSPACE_ID, PET_ID, true, root));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.query.mock.calls[0]?.[0]).toHaveProperty('query.rootItemId', root);
    expect(client.query.mock.calls[0]?.[0]).toHaveProperty(
      'path',
      '/api/v1/me/pets/runtime/note/watch',
    );
    await act(async () => {
      await result.current.send({ text: 'Read this', model: '', workspaceAccess: true });
    });
    expect(client.execute.mock.calls.at(-1)?.[0]).toHaveProperty('body.rootItemId', root);
    expect(client.execute.mock.calls.at(-1)?.[0]).toHaveProperty('body.readOnly', true);
    expect(client.execute.mock.calls.at(-1)?.[0]).toHaveProperty(
      'path',
      '/api/v1/me/pets/runtime/note',
    );
    await act(async () => {
      await result.current.send({
        text: 'Append a summary',
        model: '',
        workspaceAccess: true,
        readOnly: false,
      });
    });
    expect(client.execute.mock.calls.at(-1)?.[0]).toHaveProperty('body.rootItemId', root);
    expect(client.execute.mock.calls.at(-1)?.[0]).toHaveProperty('body.readOnly', false);
  });

  it('removes exposed note history when Core refuses its root', async () => {
    client.query
      .mockResolvedValueOnce(
        connection({
          revision: 1,
          messages: [{ id: 'private', role: 'assistant', text: 'Private material' }],
        }),
      )
      .mockRejectedValue(NixApiError.fromStatus(404));
    const { result } = renderHook(() =>
      usePetRuntime(WORKSPACE_ID, PET_ID, true, '66666666-6666-4666-8666-666666666666'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.runtime?.messages).toHaveLength(1);
    const staleSetRuntime = result.current.setRuntime;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.runtime).toBeNull();
    expect(result.current.error).toContain('no longer available');
    act(() => {
      staleSetRuntime(
        connection({ revision: 999, reason: 'Late private snapshot' }) as PetConnection,
      );
    });
    expect(result.current.runtime).toBeNull();
    const sentBefore = client.execute.mock.calls.length;
    await act(async () => {
      expect(
        await result.current.send({ text: 'Try again', model: '', workspaceAccess: true }),
      ).toBe(false);
    });
    expect(client.execute.mock.calls).toHaveLength(sentBefore);
  });
});
