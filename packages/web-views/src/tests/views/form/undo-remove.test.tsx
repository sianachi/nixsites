import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type {
  FormBlock,
  FormCondition,
  InteractiveFormDefinition,
} from '@nix/web-collections/core/container-model';
import { PageConditions } from '../../../form/editor/conditions';
import {
  EMPTY_INTERACTIVE_FORM,
  InteractiveFormEditor,
} from '../../../form/interactive-form-editor';

const block = (id: string): FormBlock => ({
  id,
  kind: 'heading',
  propertyKey: null,
  text: id,
  help: null,
  required: false,
  identityRole: null,
  visibleWhen: [],
});
const page = (id: string, blocks: FormBlock[] = []) => ({
  id,
  title: id,
  description: null,
  visibleWhen: [],
  blocks,
});
const FORM: InteractiveFormDefinition = {
  ...EMPTY_INTERACTIVE_FORM,
  pages: [page('p1'), page('p2', [block('b1'), block('b2'), block('b3')]), page('p3')],
};

function Designer(): ReactNode {
  const [form, setForm] = useState(FORM);
  return (
    <InteractiveFormEditor
      form={form}
      schema={[]}
      itemId={null}
      viewId="v"
      onChange={setForm}
      showPublishing={false}
    />
  );
}

const values = (name: RegExp | string): string[] =>
  screen.getAllByRole('textbox', { name }).map((el) => (el as HTMLInputElement).value);

describe('undoing a removal in the form designer', () => {
  it('puts a removed page back at its index', async () => {
    const user = userEvent.setup();
    render(<Designer />);
    await user.click(screen.getByRole('button', { name: 'Remove p2' }));
    expect(values(/^Page \d title$/)).toEqual(['p1', 'p3']);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(values(/^Page \d title$/)).toEqual(['p1', 'p2', 'p3']);
  });

  it('puts a removed block back at its index', async () => {
    const user = userEvent.setup();
    render(<Designer />);
    const removers = (): (string | null)[] =>
      screen
        .getAllByRole('button', { name: /^Remove b\d$/ })
        .map((el) => el.getAttribute('aria-label'));
    await user.click(screen.getByRole('button', { name: 'Remove b2' }));
    expect(removers()).toEqual(['Remove b1', 'Remove b3']);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(removers()).toEqual(['Remove b1', 'Remove b2', 'Remove b3']);
  });

  it('puts a removed condition back at its index', async () => {
    const user = userEvent.setup();
    const initial: FormCondition[] = ['a', 'b', 'c'].map((value) => ({
      fieldBlockId: 'f',
      operator: 'equals',
      value,
    }));
    function Host(): ReactNode {
      const [list, setList] = useState(initial);
      return (
        <PageConditions
          conditions={list}
          earlier={[{ ...block('f'), kind: 'field', text: 'F' }]}
          onChange={setList}
        />
      );
    }
    render(<Host />);
    const [, second] = screen.getAllByRole('button', { name: 'Remove page condition' });
    await user.click(second ?? document.body);
    expect(values('Page condition value')).toEqual(['a', 'c']);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(values('Page condition value')).toEqual(['a', 'b', 'c']);
  });
});
