import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => null,
  useOptionalApiClient: () => null,
}));

const { diagnose, ProgramEditor } = await import('../../openui/program-editor');

const workspace = '11111111-1111-4111-8111-111111111111';

function Harness({ initial }: { readonly initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <MemoryRouter>
      <ProgramEditor value={value} onChange={setValue} workspaceId={workspace} />
    </MemoryRouter>
  );
}

describe('diagnose', () => {
  it('finds nothing wrong with a sound program, and nothing to say about an empty one', () => {
    expect(diagnose('root = Stack([t])\nt = Text("Hi")')).toEqual([]);
    expect(diagnose('  ')).toEqual([]);
  });

  it('puts a statement problem on the line that statement starts on', () => {
    const problems = diagnose('root = Stack([a, b])\na = Text("x")\nb = Text()');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(3);
    expect(problems[0]?.message).toContain('missing required');
  });

  it('reports a name that is used and never defined, and a program with no root', () => {
    expect(diagnose('root = Stack([gone])')).toContainEqual({
      line: 1,
      message: '"gone" is used but never defined.',
    });
    expect(diagnose('t = Text("x")')).toContainEqual({
      line: null,
      message: 'The program needs a root: root = Stack([...]).',
    });
  });
});

describe('the program editor', () => {
  it('highlights the text it edits once the highlighter has loaded', async () => {
    const { container } = render(<Harness initial={'root = Stack([t])\nt = Text("Hi")'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    await waitFor(() => {
      expect(container.querySelector('.hljs-title')).toHaveTextContent('Stack');
    });
    expect(container.querySelector('.hljs-section')).toHaveTextContent('root');
    expect(container.querySelector('.hljs-string')).toHaveTextContent('"Hi"');
  });

  it('previews the program beside the editor and follows an edit', async () => {
    render(<Harness initial={'root = Stack([t])\nt = Text("Hello there")'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(await screen.findByText('Hello there')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Program'), {
      target: { value: 'root = Stack([t])\nt = Text("Changed")' },
    });
    expect(await screen.findByText('Changed')).toBeInTheDocument();
  });

  it('shows a parse error with its line number', async () => {
    render(<Harness initial={'root = Stack([t])\nt = Text()'} />);
    const problems = await screen.findByRole('list', { name: 'Problems' });
    expect(problems).toHaveTextContent(/Line 2: missing required/);
  });

  it('shows how big a program is once it is over the limit', async () => {
    render(<Harness initial={`root = Stack([t])\nt = Text("${'x'.repeat(33 * 1024)}")`} />);
    expect(await screen.findByText(/the limit is 32 KB/)).toBeInTheDocument();
  });
});
