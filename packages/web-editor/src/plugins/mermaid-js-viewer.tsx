import { Button, ContextMenu, Dialog, Icon, Text } from '@nix/ui';
import { Minus, Plus } from 'lucide-react';
import { useEffect, useId, useState, useSyncExternalStore, type ReactElement } from 'react';

import { saveArchive } from '@nix/web-platform/export/export-archive';
import type { FileViewerPlugin } from './file-viewer-registry';
import { mermaidThemeSnapshot, renderMermaid, subscribeToMermaidTheme } from './mermaid-render';

const MERMAID_MEDIA_TYPES = new Set([
  'application/vnd.mermaid',
  'text/mermaid',
  'text/vnd.mermaid',
  'text/x-mermaid',
]);

export function isMermaidFile(fileName: string, mediaType: string): boolean {
  const normalizedMediaType = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return MERMAID_MEDIA_TYPES.has(normalizedMediaType) || /\.(?:mmd|mermaid)$/iu.test(fileName);
}

type MermaidState = {
  readonly source: string;
  readonly theme: string;
} & (
  | { readonly html: { readonly __html: string }; readonly error: null }
  | { readonly html: null; readonly error: string }
);

function downloadDiagram(fileName: string, content: string, extension: 'svg' | 'mmd'): void {
  const stem = (fileName.split(/[\\/]/u).pop() ?? 'diagram').replace(/\.(?:mmd|mermaid)$/iu, '');
  saveArchive({
    fileName: `${stem}.${extension}`,
    blob: new Blob([content], { type: extension === 'svg' ? 'image/svg+xml' : 'text/vnd.mermaid' }),
  });
}

export function MermaidViewer({
  fileName,
  source,
}: {
  readonly fileName: string;
  readonly source: string;
}): ReactElement {
  const generatedId = useId().replace(/[^\da-z-]/giu, '');
  const theme = useSyncExternalStore(subscribeToMermaidTheme, mermaidThemeSnapshot, () => '{}');
  const [state, setState] = useState<MermaidState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const current = state?.source === source && state.theme === theme ? state : null;
  const html = current?.html ?? null;
  const svg = html?.__html ?? null;
  const error = current?.error ?? null;

  useEffect(() => {
    let active = true;
    void renderMermaid(source, `nix-mermaid-${generatedId}`)
      .then((svg) => {
        if (active) setState({ source, theme, html: { __html: svg }, error: null });
      })
      .catch((reason: unknown) => {
        if (active) {
          setState({
            source,
            theme,
            html: null,
            error:
              reason instanceof Error ? reason.message : 'Mermaid could not render this diagram.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [generatedId, source, theme]);

  const controls = (
    <div className="flex min-w-0 flex-wrap items-center gap-2" contentEditable={false}>
      <Button
        variant="icon"
        aria-label="Zoom out"
        disabled={svg === null || zoom <= 0.25}
        onClick={() => {
          setZoom(Math.max(0.25, zoom - 0.25));
        }}
      >
        <Icon icon={Minus} />
      </Button>
      <Text variant="caption" tone="muted" aria-label="Diagram zoom">
        {Math.round(zoom * 100)}%
      </Text>
      <Button
        variant="icon"
        aria-label="Zoom in"
        disabled={svg === null || zoom >= 4}
        onClick={() => {
          setZoom(Math.min(4, zoom + 0.25));
        }}
      >
        <Icon icon={Plus} />
      </Button>
      <Button
        variant="ghost"
        disabled={svg === null}
        onClick={() => {
          setZoom(1);
        }}
      >
        Fit width
      </Button>
      <Button
        variant="ghost"
        disabled={svg === null}
        onClick={() => {
          downloadDiagram(fileName, svg ?? '', 'svg');
        }}
      >
        Download SVG
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          downloadDiagram(fileName, source, 'mmd');
        }}
      >
        Download Mermaid
      </Button>
    </div>
  );

  const preview =
    html === null ? (
      <Text
        variant="bodySmall"
        as="p"
        role={error === null ? 'status' : 'alert'}
        className="rounded-md bg-surface p-4"
      >
        {error === null
          ? 'Rendering Mermaid diagram…'
          : `Mermaid could not render this diagram: ${error}`}
      </Text>
    ) : (
      <ContextMenu
        label="Diagram actions"
        items={[
          {
            label: 'Fit width',
            onSelect: () => {
              setZoom(1);
            },
          },
          {
            label: 'Expand diagram',
            disabled: expanded,
            onSelect: () => {
              setExpanded(true);
            },
          },
          {
            label: 'Download SVG',
            onSelect: () => {
              downloadDiagram(fileName, svg ?? '', 'svg');
            },
          },
          {
            label: 'Download Mermaid',
            onSelect: () => {
              downloadDiagram(fileName, source, 'mmd');
            },
          },
        ]}
      >
        {(target) => (
          <div
            {...target}
            className={
              expanded
                ? 'min-w-0 max-w-full max-h-[calc(100dvh-var(--spacing)*32)] overflow-auto rounded-md bg-surface p-2 sm:p-4'
                : 'min-w-0 max-w-full max-h-96 overflow-auto rounded-md bg-surface p-2 sm:p-4'
            }
            tabIndex={0} // eslint-disable-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll zoomed diagrams.
            role="region"
            aria-label="Scrollable diagram"
          >
            <div
              role="img"
              aria-label={`${fileName} diagram`}
              className="[&_svg]:block [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-none!"
              style={{ width: `${String(zoom * 100)}%` }} // design-token-exempt: zoom is a user-controlled diagram scale.
              dangerouslySetInnerHTML={html}
            />
          </div>
        )}
      </ContextMenu>
    );

  return (
    <section
      aria-label={`Mermaid diagram from ${fileName}`}
      className="min-w-0 max-w-full space-y-3"
      contentEditable={false}
    >
      {expanded ? null : (
        <>
          {controls}
          {preview}
        </>
      )}
      <Button
        variant="secondary"
        disabled={svg === null}
        onClick={() => {
          setExpanded(true);
        }}
      >
        Expand diagram
      </Button>
      <Dialog
        open={expanded}
        title={fileName}
        onClose={() => {
          setExpanded(false);
        }}
        presentation="workspace"
      >
        <div className="min-w-0 space-y-3">
          {controls}
          {preview}
        </div>
      </Dialog>
      {error === null ? null : (
        <details>
          <summary className="cursor-pointer py-2">Show Mermaid source</summary>
          <pre className="mt-2 max-w-full overflow-auto rounded-md bg-surface p-2 text-base sm:p-4 sm:text-sm">
            {source}
          </pre>
        </details>
      )}
    </section>
  );
}

export const mermaidJsViewerPlugin: FileViewerPlugin = {
  id: 'nix.mermaid-js.viewer',
  matches: ({ fileName, mediaType }) => isMermaidFile(fileName, mediaType),
  Component: MermaidViewer,
};
