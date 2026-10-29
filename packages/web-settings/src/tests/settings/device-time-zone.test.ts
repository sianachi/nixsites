import { NixApiError, type PrincipalPreferencesResponse } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveDeviceTimeZoneOnce } from '../../settings/shared/preference-defaults';

type Client = Parameters<typeof saveDeviceTimeZoneOnce>[0];

function saved(overrides: Partial<PrincipalPreferencesResponse>): PrincipalPreferencesResponse {
  return {
    revision: 0,
    timeZone: 'Etc/UTC',
    quietStart: null,
    quietEnd: null,
    dueReminderTime: '09:00',
    dueReminders: true,
    habitReminders: true,
    mutedContainerIds: [],
    ...overrides,
  };
}

function clientFor(response: PrincipalPreferencesResponse | Error) {
  const query = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  const execute = vi.fn(() => Promise.resolve({}));
  return { client: { query, execute } as unknown as Client, query, execute };
}

beforeEach(() => {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    timeZone: 'Europe/London',
  } as Intl.ResolvedDateTimeFormatOptions);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveDeviceTimeZoneOnce', () => {
  it('saves the device zone exactly once for a never-saved user', async () => {
    const { client, query, execute } = clientFor(saved({}));
    expect(await saveDeviceTimeZoneOnce(client)).toBe(true);
    expect(await saveDeviceTimeZoneOnce(client)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('never overwrites a saved zone', async () => {
    for (const response of [
      saved({ revision: 3, timeZone: 'Asia/Tokyo' }),
      saved({ revision: 2 }),
    ]) {
      const { client, execute } = clientFor(response);
      expect(await saveDeviceTimeZoneOnce(client)).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('swallows a failed read or a failed write', async () => {
    const failing = new NixApiError({ kind: 'problem', code: 'x', message: 'x', status: 500 });
    expect(await saveDeviceTimeZoneOnce(clientFor(failing).client)).toBe(false);
    const { client, execute } = clientFor(saved({}));
    execute.mockRejectedValue(failing);
    await expect(saveDeviceTimeZoneOnce(client)).resolves.toBe(false);
  });
});
