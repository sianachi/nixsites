import { Text } from '@nix/ui';
import type { ReactElement } from 'react';

import { bareMediaType, fileExtension, type FileViewerPlugin } from './file-viewer-registry';

/**
 * Plain text and source code, shown as what they are.
 *
 * Last in the registry on purpose: anything more specific - a diagram, a table, a Markdown
 * document - claims its file first, and this takes whatever text is left. It claims by media type
 * and, because uploads from a browser often arrive as `application/octet-stream`, by the
 * extensions a technical team actually stores.
 */

const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
  'application/javascript',
  'application/typescript',
  'application/sql',
  'application/x-httpd-php',
]);

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'log',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'js',
  'mjs',
  'cjs',
  'ts',
  'mts',
  'cts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'fs',
  'swift',
  'm',
  'php',
  'pl',
  'lua',
  'r',
  'sql',
  'graphql',
  'gql',
  'proto',
  'tf',
  'hcl',
  'nix',
  'dockerfile',
  'makefile',
  'gitignore',
  'editorconfig',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'svelte',
  'vue',
  'diff',
  'patch',
]);

/** Past this many characters the viewer shows the head and says so; a log file is not a page. */
export const TEXT_VIEWER_LIMIT = 500_000;

export function isTextFile(fileName: string, mediaType: string): boolean {
  const type = bareMediaType(mediaType);
  if (type.startsWith('text/')) {
    return true;
  }
  if (TEXT_MEDIA_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml')) {
    return true;
  }
  const extension = fileExtension(fileName);
  return TEXT_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(fileName.toLowerCase());
}

export function TextViewer({
  fileName,
  source,
}: {
  readonly fileName: string;
  readonly source: string;
}): ReactElement {
  const truncated = source.length > TEXT_VIEWER_LIMIT;
  const shown = truncated ? source.slice(0, TEXT_VIEWER_LIMIT) : source;
  const lines = shown.split('\n');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {truncated ? (
        <Text variant="note" tone="muted" as="p" role="status" className="px-2 py-2 sm:px-8">
          Showing the first {TEXT_VIEWER_LIMIT.toLocaleString()} characters of {fileName}. Download
          the file for the rest.
        </Text>
      ) : null}
      <div
        role="region"
        aria-label={`${fileName} source`}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to scroll wider source listings.
        tabIndex={0}
        className="min-h-0 min-w-0 flex-1 overflow-auto py-4"
      >
        {/* text-primitive-exempt: a source listing is monospace by nature and takes its
            size from the code step; a wrapping primitive would wrap it in a paragraph. */}
        <pre
          aria-label={fileName}
          className="grid grid-cols-[auto_1fr] font-mono text-sm leading-relaxed text-foreground"
        >
          {lines.map((line, index) => (
            <span key={index} className="contents">
              <span
                aria-hidden="true"
                className="sticky left-0 bg-background pr-2 pl-2 sm:pr-4 sm:pl-8 text-right text-muted select-none"
              >
                {index + 1}
              </span>
              <span className="pr-2 whitespace-pre sm:pr-8">{line}</span>
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

export const textViewerPlugin: FileViewerPlugin = {
  id: 'nix.text.viewer',
  matches: ({ fileName, mediaType }) => isTextFile(fileName, mediaType),
  Component: TextViewer,
};
