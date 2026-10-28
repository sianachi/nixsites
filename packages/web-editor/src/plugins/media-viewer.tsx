import type { ReactElement } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { AudioPlayer } from '@nix/web-foundation/audio/audio-player';
import { authorisedAudioUrl } from '@nix/web-foundation/audio/audio-source';
import {
  bareMediaType,
  fileExtension,
  type FileViewerPlugin,
  type FileViewerProps,
} from './file-viewer-registry';

/**
 * Audio and video, played in place.
 *
 * Video is a `url` viewer: the browser's own element takes the object URL the host makes from the
 * authorised bytes. Audio is a `stream` viewer instead - it is handed the authorised capability
 * address itself and streams from it with range requests, because holding a recording of up to
 * the upload limit in memory before the first second plays is not a player. Nothing here decodes
 * anything.
 */

const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'flac',
  'aac',
  'opus',
  'weba',
]);
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);

export function mediaKind(fileName: string, mediaType: string): 'audio' | 'video' | null {
  const type = bareMediaType(mediaType);
  if (type.startsWith('audio/')) {
    return 'audio';
  }
  if (type.startsWith('video/')) {
    return 'video';
  }
  const extension = fileExtension(fileName);
  if (AUDIO_EXTENSIONS.has(extension)) {
    return 'audio';
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }
  return null;
}

export function MediaViewer({ fileName, source }: FileViewerProps): ReactElement {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-2 sm:p-8">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- an uploaded recording has no track to offer. */}
      <video
        controls
        src={source}
        aria-label={fileName}
        className="max-h-full max-w-full rounded-md"
      />
    </div>
  );
}

/**
 * Audio plays through the shared store, not through an element in this tree, so it keeps playing
 * when the person leaves the page and the shell's mini player can take over.
 */
export function AudioViewer({ fileName, itemId, onDownload }: FileViewerProps): ReactElement {
  const client = useApiClient();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 p-2 sm:gap-6 sm:p-8">
      <AudioPlayer
        itemId={itemId}
        title={fileName}
        resolveUrl={() => authorisedAudioUrl(client, itemId)}
        onDownload={onDownload}
      />
    </div>
  );
}

export const audioViewerPlugin: FileViewerPlugin = {
  id: 'nix.audio.viewer',
  matches: ({ fileName, mediaType }) => mediaKind(fileName, mediaType) === 'audio',
  source: 'stream',
  Component: AudioViewer,
};

export const mediaViewerPlugin: FileViewerPlugin = {
  id: 'nix.media.viewer',
  matches: ({ fileName, mediaType }) => mediaKind(fileName, mediaType) === 'video',
  source: 'url',
  Component: MediaViewer,
};
