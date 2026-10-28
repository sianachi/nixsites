import { files, type NixClient } from '@nix/api-client';

import { authorisedAudioUrl } from './audio-source';
import { getAudioState, play, resume, seek } from './audio-store';

/**
 * Plays a recording from a moment in it, in the application's one player.
 *
 * What a transcript's timestamp does when it is clicked: the note stays where it is and the
 * recording is heard from that line, with the mini player in the shell to pause or follow it.
 * A recording that is already loaded is moved rather than reloaded.
 */
export async function playRecordingFrom(
  client: NixClient,
  itemId: string,
  seconds: number,
): Promise<void> {
  if (getAudioState().track?.itemId === itemId) {
    seek(seconds);
    resume();
    return;
  }
  const fresh = (): Promise<string> => authorisedAudioUrl(client, itemId);
  const [url, record] = await Promise.all([fresh(), client.query(files.fileByItem(itemId))]);
  play({ itemId, title: record.current.fileName, url }, fresh);
  // Before the file has said how long it is, this is kept and applied when it does.
  seek(seconds);
}
