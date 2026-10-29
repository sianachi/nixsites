import { describe, expect, it, vi } from 'vitest';
import * as bodies from '../../lib/body-cache';
import { memoryStorage } from '../../testing/memory-storage';
import { prepareHealthyAdmission, resetSession, signedIn } from '../../testing/render-with-router';

describe('healthy account fixture admission', () => {
  it('reports a failure belonging to the current fixture', async () => {
    signedIn();
    const failure = new Error('Current storage cannot be opened.');
    vi.spyOn(bodies, 'openBodyCache').mockRejectedValue(failure);
    await expect(prepareHealthyAdmission()).rejects.toBe(failure);
  });

  it.each(['session', 'storage', 'epoch'])(
    'cancels a rejected setup after its %s lifecycle changes',
    async (changed) => {
      signedIn();
      vi.stubGlobal('localStorage', memoryStorage());
      vi.spyOn(bodies, 'openBodyCache').mockRejectedValue(new Error('Superseded setup.'));
      const epoch = vi.spyOn(bodies, 'bodyCacheAccountEpoch').mockReturnValue('original');
      const opening = prepareHealthyAdmission();
      if (changed === 'session') resetSession();
      else if (changed === 'storage') vi.stubGlobal('localStorage', memoryStorage());
      else epoch.mockReturnValue('replacement');
      await expect(opening).resolves.toBeUndefined();
    },
  );
});
