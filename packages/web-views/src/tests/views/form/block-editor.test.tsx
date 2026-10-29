import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FormBlock } from '@nix/web-collections/core/container-model';
import { BlockEditor } from '../../../form/editor/block-editor';

const block = (conditions: number): FormBlock => ({
  id: 'b',
  kind: 'field',
  propertyKey: null,
  text: 'Q',
  help: null,
  required: false,
  identityRole: null,
  visibleWhen: Array.from({ length: conditions }, () => ({
    fieldBlockId: 'a',
    operator: 'equals',
    value: 'x',
  })),
});

const mount = (conditions: number) =>
  render(
    <BlockEditor
      block={block(conditions)}
      schema={[]}
      earlier={[]}
      onChange={vi.fn()}
      onRemove={vi.fn()}
      onMove={vi.fn()}
      canMoveUp={false}
      canMoveDown={false}
    />,
  );

describe('the form block editor', () => {
  it('says condition for one and conditions for several', () => {
    const { unmount } = mount(1);
    expect(screen.getByText(/More options \(1 condition\)/)).toBeInTheDocument();
    unmount();
    mount(2);
    expect(screen.getByText(/More options \(2 conditions\)/)).toBeInTheDocument();
  });
});
