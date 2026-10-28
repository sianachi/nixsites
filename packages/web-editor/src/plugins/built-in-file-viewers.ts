import { csvViewerPlugin } from './csv-viewer';
import { epubViewerPlugin } from './epub-viewer';
import { createFileViewerRegistry } from './file-viewer-registry';
import { markdownViewerPlugin } from './markdown-viewer';
import { audioViewerPlugin, mediaViewerPlugin } from './media-viewer';
import { mermaidJsViewerPlugin } from './mermaid-js-viewer';
import { textViewerPlugin } from './text-viewer';

/**
 * Most specific first: a `.mmd` is text, a `.csv` is text, a `.md` is text, and each of them is
 * something better than text. The plain text viewer is last and takes what remains.
 */
export const builtInFileViewerPlugins = [
  mermaidJsViewerPlugin,
  markdownViewerPlugin,
  csvViewerPlugin,
  epubViewerPlugin,
  audioViewerPlugin,
  mediaViewerPlugin,
  textViewerPlugin,
] as const;

export const findBuiltInFileViewer = createFileViewerRegistry(builtInFileViewerPlugins);
