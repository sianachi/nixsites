import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PreviewBodyEdit } from '@nix/structure-spec';
import { PetBodyEditPreview } from '../../pets/pet-body-edit-preview';

const section: PreviewBodyEdit = {
  scope: 'section',
  subject: 'Section “Budget” in Trip plan',
  before: '## Budget\n\nTotal is **400**.',
  after: '## Budget\n\nTotal is **450**.\n\n- Venue\n- Food',
  blocksRemoved: 1,
  blocksAdded: 2,
  losesFormatting: false,
};

const passage: PreviewBodyEdit = {
  scope: 'list item',
  subject: 'List item with “Shirts” in Trip plan',
  before: 'Shirts',
  after: 'T-shirts',
  beforeRange: { start: 0, end: 1 },
  afterRange: { start: 0, end: 3 },
  blocksRemoved: 1,
  blocksAdded: 1,
  losesFormatting: false,
};

describe('PetBodyEditPreview', () => {
  it('names both sides with their subject and shows each in full as plain text', () => {
    render(<PetBodyEditPreview edit={section} />);
    const now = screen.getByRole('region', { name: 'Text now, Section “Budget” in Trip plan' });
    const after = screen.getByRole('region', {
      name: 'Text after this change, Section “Budget” in Trip plan',
    });
    // Plain text, never rendered Markdown: the model chose the new side.
    expect(now).toHaveTextContent('## Budget removed: Total is **400**.');
    expect(after).toHaveTextContent('## Budget added: Total is **450**. added: - Venue - Food');
    expect(within(now).queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('Text now')).toBeVisible();
    expect(screen.queryByText(/lines\)/)).not.toBeInTheDocument();
    expect(screen.getByText('The edited part of the note, before and after')).toBeVisible();
    // Both regions take focus so a long side scrolls from the keyboard.
    expect(now).toHaveAttribute('tabindex', '0');
    expect(after).toHaveAttribute('tabindex', '0');
  });

  it('marks changed section lines as removed and added, in words as well as style', () => {
    const { container } = render(<PetBodyEditPreview edit={section} />);
    const removed = container.querySelectorAll('del');
    const added = container.querySelectorAll('ins');
    expect(Array.from(removed, (node) => node.textContent)).toEqual(['removed: Total is **400**.']);
    // The blank line between the paragraph and the list is never marked.
    expect(Array.from(added, (node) => node.textContent)).toEqual([
      'added: Total is **450**.\n',
      'added: - Venue\n- Food',
    ]);
  });

  it('marks only the changed characters of a passage', () => {
    const { container } = render(<PetBodyEditPreview edit={passage} />);
    expect(container.querySelector('del')?.textContent).toBe('removed: S');
    expect(container.querySelector('ins')?.textContent).toBe('added: T-s');
    expect(
      screen.getByRole('region', { name: 'Text now, List item with “Shirts” in Trip plan' }),
    ).toHaveTextContent('removed: Shirts');
  });

  it('scrolls each side to its first change', () => {
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-change') ? 120 : 0;
      },
    });
    try {
      render(<PetBodyEditPreview edit={section} />);
      // Two lines of context (jsdom has no line height, so 20px each) above the change.
      expect(screen.getByRole('region', { name: /^Text now/ }).scrollTop).toBe(80);
    } finally {
      if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
    }
  });

  it('says in words when the edit removes the text, with no empty box', () => {
    render(
      <PetBodyEditPreview
        edit={{ ...passage, after: '', afterRange: { start: 0, end: 0 }, blocksAdded: 0 }}
      />,
    );
    expect(screen.queryByRole('region', { name: /^Text after/ })).not.toBeInTheDocument();
    expect(screen.getByText('Nothing replaces it: this text is removed.')).toBeVisible();
  });

  it('uses past-tense labels once the edit has been applied', () => {
    render(<PetBodyEditPreview edit={section} phase="applied" />);
    expect(
      screen.getByText('The edited part of the note, before and after this change'),
    ).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'Text before, Section “Budget” in Trip plan' }),
    ).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'Text after, Section “Budget” in Trip plan' }),
    ).toBeVisible();
  });
});
