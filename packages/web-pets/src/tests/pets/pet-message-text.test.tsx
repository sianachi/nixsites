import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { PetMessageText } from '../../pets/pet-message-text';
const workspace = '11111111-1111-4111-8111-111111111111';
describe('pet result links', () => {
  it('makes same-workspace citations navigable', () => {
    const path = `/w/${workspace}?item=22222222-2222-4222-8222-222222222222`;
    render(
      <MemoryRouter>
        <PetMessageText workspaceId={workspace} text={`Created [Release plan](${path}).`} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Release plan' })).toHaveAttribute('href', path);
  });
  it('keeps arbitrary URLs and HTML inert', () => {
    render(
      <MemoryRouter>
        <PetMessageText
          workspaceId={workspace}
          text={'[Run](javascript:alert(1)) <img src=x onerror=alert(1)>'}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it('makes a bare Nix result path clickable too', () => {
    const path = `/w/${workspace}?item=22222222-2222-4222-8222-222222222222`;
    render(
      <MemoryRouter>
        <PetMessageText workspaceId={workspace} text={`Link: ${path}`} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Open note' })).toHaveAttribute('href', path);
  });
  it('formats a reply as paragraphs, a list and emphasized view names', () => {
    render(
      <MemoryRouter>
        <PetMessageText
          workspaceId={workspace}
          text={
            'Nix supports these views:\n\n- **List** — rows\n- **Board** — cards\n\nWorkspace access is off.'
          }
        />
      </MemoryRouter>,
    );
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('List').tagName).toBe('STRONG');
    expect(screen.getByText('Workspace access is off.').tagName).toBe('P');
    expect(screen.queryByText(/\*\*List\*\*/)).not.toBeInTheDocument();
  });
  it('keeps links in inline and fenced code literal', () => {
    const path = `/w/${workspace}?item=22222222-2222-4222-8222-222222222222`;
    const { container } = render(
      <MemoryRouter>
        <PetMessageText
          workspaceId={workspace}
          text={`\`${path}\`\n\n\`\`\`text\n[Plan](${path})\n\`\`\``}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container.querySelector('pre code')).toHaveTextContent(`[Plan](${path})`);
  });
  it('makes explicitly selected cross-workspace citations navigable in a chat note', () => {
    const source = '33333333-3333-4333-8333-333333333333';
    const path = `/w/${source}?item=22222222-2222-4222-8222-222222222222`;
    render(
      <MemoryRouter>
        <PetMessageText
          workspaceId={workspace}
          sourceWorkspaceIds={[source]}
          text={`Source: ${path}`}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Open note' })).toHaveAttribute('href', path);
  });

  it('does not load images or activate external, cross-workspace or deceptive links', () => {
    const otherWorkspace = '33333333-3333-4333-8333-333333333333';
    render(
      <MemoryRouter>
        <PetMessageText
          workspaceId={workspace}
          text={`[Web](https://example.com)\n\n[Other](/w/${otherWorkspace}?item=22222222-2222-4222-8222-222222222222)\n\n[Fake](https://example.com/w/${workspace}?item=22222222-2222-4222-8222-222222222222)\n\n![Tracking](https://example.com/pixel.png)`}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Web')).toBeInTheDocument();
    expect(screen.getByText(/!\[Tracking\]/)).toBeInTheDocument();
  });
  it('renders numbered lists, quotes and tables with their semantics', () => {
    render(
      <MemoryRouter>
        <PetMessageText
          workspaceId={workspace}
          text={
            '### Choices\n\n3. First\n4. Second\n\n> A quote with *emphasis*.\n\n| View | Use |\n| --- | --- |\n| List | Rows |'
          }
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Choices' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveAttribute('start', '3');
    expect(screen.getByText('emphasis').tagName).toBe('EM');
    expect(
      within(screen.getByRole('table')).getByRole('columnheader', { name: 'View' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Rows' })).toBeInTheDocument();
  });
  it('updates an incomplete streaming reply into formatted Markdown', () => {
    const view = render(<PetMessageText workspaceId={workspace} text="Views include **Li" />);
    expect(screen.getByText('Views include **Li')).toBeInTheDocument();
    view.rerender(<PetMessageText workspaceId={workspace} text="Views include **List**." />);
    expect(screen.getByText('List').tagName).toBe('STRONG');
  });
  it('starts a reply at h3 beneath the conversation heading even when its source starts at h3', () => {
    render(
      <section aria-label="Conversation with Pip">
        <h2>Pip</h2>
        <PetMessageText workspaceId={workspace} text={'### Next steps\n\nOpen a container.'} />
      </section>,
    );
    expect(screen.getByRole('heading', { name: 'Pip', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Next steps', level: 3 })).toBeInTheDocument();
  });
  it('preserves nested, skipped and decreasing source headings without skipping rendered levels', () => {
    render(
      <PetMessageText
        workspaceId={workspace}
        text={
          '### Overview\n\n##### Nested\n\n###### Details\n\n#### Sibling\n\n## New section\n\n#### Child\n\n# Root\n\n### Topic\n\n### Peer'
        }
      />,
    );
    expect(screen.getAllByRole('heading').map((heading) => heading.tagName)).toEqual([
      'H3',
      'H4',
      'H5',
      'H4',
      'H3',
      'H4',
      'H3',
      'H4',
      'H4',
    ]);
  });
  it('caps deep nesting at h6 and starts a separate reply with a fresh outline', () => {
    render(
      <>
        <PetMessageText
          workspaceId={workspace}
          text={'# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six'}
        />
        <PetMessageText workspaceId={workspace} text="###### Another reply" />
      </>,
    );
    expect(screen.getAllByRole('heading').map((heading) => heading.tagName)).toEqual([
      'H3',
      'H4',
      'H5',
      'H6',
      'H6',
      'H6',
      'H3',
    ]);
  });
  it('preserves literal Markdown in a user message', () => {
    render(
      <PetMessageText
        workspaceId={workspace}
        format="plain"
        text={'### Next steps\n\n- **List**'}
      />,
    );
    expect(screen.getByText(/### Next steps/)).toHaveTextContent('- **List**');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
  it('shows code plainly, then highlights it, keeps its markup inert and copies the raw code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const code = 'const a = "<img src=x onerror=alert(1)>";';
    const { container } = render(
      <PetMessageText workspaceId={workspace} text={`\`\`\`js\n${code}\n\`\`\``} />,
    );
    expect(container.querySelector('code')).toHaveTextContent(code);
    await waitFor(() => {
      expect(container.querySelector('.hljs-keyword')).toHaveTextContent('const');
    });
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith(code);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });
  });

  it('says so when the clipboard refuses, then goes back to Copy code', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<PetMessageText workspaceId={workspace} text={'```js\nconst a = 1;\n```'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Copy code' }, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it.each(['constructor', '__proto__'])(
    'renders a "%s" fence as escaped text',
    async (language) => {
      const { container } = render(
        <PetMessageText
          workspaceId={workspace}
          text={`\`\`\`${language}\nconst a = "<b>";\n\`\`\``}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector('code')?.innerHTML).toBe('const a = "&lt;b&gt;";');
      });
      expect(container.querySelector('.hljs-keyword')).toBeNull();
    },
  );
});
