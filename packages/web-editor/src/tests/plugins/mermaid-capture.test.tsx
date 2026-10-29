import { nixExtensions } from '@nix/editor-schema';
import { EditorContent, ReactNodeViewRenderer, useEditor, type Editor } from '@tiptap/react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_DELAY_MS,
  MermaidCaptureContext,
  sha256Hex,
  type MermaidCaptureUpload,
} from '../../plugins/mermaid-capture';
import { MermaidCodeBlockView } from '../../plugins/mermaid-code-block-view';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(), parse: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

const SOURCE = 'flowchart LR\n  Web --> Core';
const DRAWN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50" width="100%" onload="alert(1)"><script>alert(2)</script><foreignObject><div>x</div></foreignObject><text>Core</text></svg>';

const extensions = nixExtensions.map((extension) =>
  extension.name === 'codeBlock'
    ? extension.extend({
        addNodeView() {
          return ReactNodeViewRenderer(MermaidCodeBlockView);
        },
      })
    : extension,
);

let editor: Editor | null = null;

function Harness({
  upload,
  editable = true,
  attrs = {},
}: {
  readonly upload: MermaidCaptureUpload | null;
  readonly editable?: boolean;
  readonly attrs?: Record<string, unknown>;
}) {
  const instance = useEditor({
    extensions,
    editable,
    onCreate: ({ editor: created }) => {
      editor = created;
    },
    content: {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'mermaid', ...attrs },
          content: [{ type: 'text', text: SOURCE }],
        },
      ],
    },
  });
  return (
    <MermaidCaptureContext.Provider value={upload}>
      <EditorContent editor={instance} />
    </MermaidCaptureContext.Provider>
  );
}

function codeBlockAttrs(): Record<string, unknown> {
  return editor?.state.doc.firstChild?.attrs ?? {};
}

async function settle(ms = CAPTURE_DELAY_MS + 10): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mermaid.initialize.mockReset();
  mermaid.render.mockReset().mockResolvedValue({ svg: DRAWN });
  mermaid.parse.mockReset();
});

afterEach(() => {
  cleanup();
  editor = null;
  vi.useRealTimers();
});

describe('Mermaid capture', () => {
  it('uploads a sanitised, stamped picture once the source is still, and records it', async () => {
    const upload = vi.fn<MermaidCaptureUpload>().mockResolvedValue('file-1');
    render(<Harness upload={upload} />);
    await settle(CAPTURE_DELAY_MS - 100);
    expect(upload).not.toHaveBeenCalled();
    await settle(200);
    await vi.waitFor(() => {
      expect(codeBlockAttrs().renderFileId).toBe('file-1');
    });

    const digest = await sha256Hex(SOURCE);
    expect(upload).toHaveBeenCalledTimes(1);
    const [blob, target] = upload.mock.calls[0] ?? [];
    expect(target).toBeNull();
    expect(blob?.type).toBe('image/svg+xml');
    const svg = await blob?.text();
    expect(svg).toContain(`data-nix-source-sha256="${digest}"`);
    expect(svg).toContain('<text>Core</text>');
    expect(svg).not.toMatch(/script|alert|onload|foreignObject/);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'neutral', htmlLabels: false, securityLevel: 'strict' }),
    );
    // An undefined override erases Mermaid's own connector colour (`stroke:undefined`).
    const config = mermaid.initialize.mock.lastCall?.[0] as { themeVariables: object };
    expect(Object.values(config.themeVariables)).not.toContain(undefined);
    expect(codeBlockAttrs().renderSourceHash).toBe(digest);

    // The recorded hash now matches, so nothing captures again.
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('captures an edited diagram into the same file, once, after typing stops', async () => {
    const digest = await sha256Hex(SOURCE);
    const upload = vi.fn<MermaidCaptureUpload>().mockResolvedValue('file-1');
    render(
      <Harness upload={upload} attrs={{ renderFileId: 'file-1', renderSourceHash: digest }} />,
    );
    await settle();
    expect(upload).not.toHaveBeenCalled();

    for (const character of ' --> Sites') {
      act(() => {
        editor?.commands.insertContentAt(
          (editor.state.doc.firstChild?.nodeSize ?? 2) - 1,
          character,
        );
      });
      await settle(300);
    }
    expect(upload).not.toHaveBeenCalled();
    await settle();
    await vi.waitFor(() => {
      expect(upload).toHaveBeenCalledTimes(1);
    });
    expect(upload.mock.calls[0]?.[1]).toBe('file-1');
    const edited = editor?.state.doc.firstChild?.textContent ?? '';
    expect(edited).toContain('Sites');
    await vi.waitFor(async () => {
      expect(codeBlockAttrs().renderSourceHash).toBe(await sha256Hex(edited));
    });
  });

  it('never captures for a read-only editor or without an upload (offline, locked, viewer)', async () => {
    const upload = vi.fn<MermaidCaptureUpload>().mockResolvedValue('file-1');
    render(<Harness upload={upload} editable={false} />);
    await settle();
    cleanup();
    render(<Harness upload={null} />);
    await settle();
    expect(upload).not.toHaveBeenCalled();
    expect(mermaid.initialize).not.toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'neutral' }),
    );
    expect(codeBlockAttrs().renderFileId).toBeNull();
  });

  it('keeps non-Mermaid code blocks as plain editor content without loading a diagram', async () => {
    const upload = vi.fn<MermaidCaptureUpload>().mockResolvedValue('file-1');
    render(<Harness upload={upload} attrs={{ language: 'typescript' }} />);

    expect(document.querySelector('.node-codeBlock')).toBeVisible();
    expect(screen.queryByText('Loading Mermaid diagram…')).not.toBeInTheDocument();
    await settle();
    expect(upload).not.toHaveBeenCalled();
    expect(mermaid.initialize).not.toHaveBeenCalled();
  });

  it('keeps publishing code when the diagram does not render', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error'));
    const upload = vi.fn<MermaidCaptureUpload>().mockResolvedValue('file-1');
    render(<Harness upload={upload} />);
    await settle();
    expect(upload).not.toHaveBeenCalled();
    expect(codeBlockAttrs().renderFileId).toBeNull();
  });
});
