import { describe, expect, it } from 'vitest';

import { parseAudioTimestamp } from '../../lib/audio-timestamp-link';

const ORIGIN = 'https://nix.example';
const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const AUDIO = 'b1000000-0000-4000-8000-000000000001';

describe('a transcript timestamp', () => {
  it('names a recording and a moment in it', () => {
    expect(parseAudioTimestamp(`/w/${WORKSPACE}?item=${AUDIO}&t=754`, ORIGIN)).toEqual({
      workspaceId: WORKSPACE,
      itemId: AUDIO,
      seconds: 754,
    });
    expect(
      parseAudioTimestamp(`${ORIGIN}/w/${WORKSPACE}/?item=${AUDIO}&t=0`, ORIGIN)?.seconds,
    ).toBe(0);
  });

  it('is not claimed for any other link', () => {
    const refused = [
      `/w/${WORKSPACE}?item=${AUDIO}`,
      `/w/${WORKSPACE}?item=${AUDIO}&t=-5`,
      `/w/${WORKSPACE}?item=${AUDIO}&t=1.5`,
      `/w/${WORKSPACE}?item=${AUDIO}&t=9999999`,
      `/w/${WORKSPACE}?item=not-an-item&t=5`,
      `/w/not-a-workspace?item=${AUDIO}&t=5`,
      `/w/${WORKSPACE}/daily?item=${AUDIO}&t=5`,
      `https://elsewhere.example/w/${WORKSPACE}?item=${AUDIO}&t=5`,
      'javascript:alert(1)',
      'http://[bad',
      '',
    ];
    for (const href of refused) {
      expect(parseAudioTimestamp(href, ORIGIN), href).toBeNull();
    }
  });
});
