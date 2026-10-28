import { Text } from '@nix/ui';
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { lazy, Suspense, useId, type ReactElement } from 'react';

import { useMermaidCapture } from './mermaid-capture';

const MermaidViewer = lazy(async () => ({
  default: (await import('./mermaid-js-viewer')).MermaidViewer,
}));

function stringAttr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The node-view shell stays in the editor chunk. Mermaid itself is only needed after this guard
 * accepts a Mermaid fence, at which point the preview subtree loads it on demand.
 */
export function MermaidCodeBlockView({ node, editor, getPos }: ReactNodeViewProps): ReactElement {
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
  const source = node.textContent;
  const mermaidBlock = /^mermaid$/iu.test(language.trim());
  const captureId = useId().replace(/[^\da-z-]/giu, '');

  useMermaidCapture(
    {
      source: mermaidBlock ? source : '',
      renderFileId: stringAttr(node.attrs.renderFileId),
      renderSourceHash: stringAttr(node.attrs.renderSourceHash),
      editable: editor.isEditable,
      commit: (renderFileId, renderSourceHash) => {
        const position = getPos();
        if (typeof position !== 'number' || !editor.isEditable) return;
        const current = editor.state.doc.nodeAt(position);
        if (current?.type.name !== 'codeBlock') return;
        // Bookkeeping, not an edit: undo must not step back through a capture.
        editor.view.dispatch(
          editor.state.tr
            .setNodeMarkup(position, undefined, {
              ...current.attrs,
              renderFileId,
              renderSourceHash,
            })
            .setMeta('addToHistory', false),
        );
      },
    },
    captureId,
  );

  if (!mermaidBlock) {
    return (
      <NodeViewWrapper>
        <NodeViewContent />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="min-w-0 max-w-full">
      <Suspense
        fallback={
          <Text variant="bodySmall" as="p" role="status" className="rounded-md bg-surface p-4">
            Loading Mermaid diagram…
          </Text>
        }
      >
        <MermaidViewer fileName="Mermaid code block" source={source} />
      </Suspense>
      <details className="mt-3">
        <summary className="cursor-pointer py-2">Show Mermaid source</summary>
        <NodeViewContent className="mt-2 max-w-full overflow-auto rounded-md bg-surface p-2 font-mono text-base sm:p-4 sm:text-sm" />
      </details>
    </NodeViewWrapper>
  );
}
