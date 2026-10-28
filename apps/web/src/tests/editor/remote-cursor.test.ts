import { describe, expect, it } from 'vitest';

import { remoteCursor } from '@nix/web-editor/editor/remote-cursor';

describe('a collaborator’s caret', () => {
  it('is a thin line with a floating initials circle, not a name block in the text', () => {
    const caret = remoteCursor({ name: 'Ada Lovelace', color: 'var(--color-accent-600)' });

    expect(caret.title).toBe('Ada Lovelace');
    expect(caret.style.borderColor).toBe('var(--color-accent-600)');
    const profile = caret.querySelector('span');
    expect(profile?.textContent).toBe('AL');
    expect(profile?.className).toContain('absolute');
    expect(profile?.className).toContain('rounded-full');
    expect(profile).toHaveAttribute('aria-hidden', 'true');
  });

  it('copes with a collaborator who has no name or colour yet', () => {
    const caret = remoteCursor({});

    expect(caret.title).toBe('Someone');
    expect(caret.querySelector('span')?.textContent).toBe('S');
  });
});
