import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import OpenUiBlock from '../../openui/openui-block';
import { PetMessageText } from '../../pets/pet-message-text';
import calculator from './fixtures/keypad-calculator.openui?raw';
import catQuiz from './fixtures/cat-quiz.openui?raw';
import tdee from './fixtures/tdee-calculator.openui?raw';

const workspace = '11111111-1111-4111-8111-111111111111';

function block(source: string, onAsk?: (message: string) => void) {
  return render(
    <MemoryRouter>
      <OpenUiBlock
        source={source}
        workspaceIds={[workspace]}
        fallback={<pre>fallback</pre>}
        {...(onAsk ? { onAsk } : {})}
      />
    </MemoryRouter>,
  );
}

function press(...labels: string[]) {
  for (const label of labels) fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('generated tools built from generic primitives', () => {
  it('computes on a keypad calculator', async () => {
    block(calculator);
    await screen.findByRole('button', { name: '7' });
    press('7', '+', '5', '=');
    expect(await screen.findByText('12')).toBeInTheDocument();
    press('C', '9', '*', '6', '=');
    expect(await screen.findByText('54')).toBeInTheDocument();
  });

  it('recomputes a TDEE calculator as inputs change', async () => {
    block(tdee);
    expect(await screen.findByText('1649')).toBeInTheDocument();
    expect(screen.getByText('2556')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Activity'), { target: { value: 'sedentary' } });
    // 1648.75 * 1.2
    expect(await screen.findByText('1979')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Sex'), { target: { value: 'female' } });
    // (1648.75 - 166) = 1482.75, * 1.2
    expect(await screen.findByText('1779')).toBeInTheDocument();
  });

  it('scores an Are you a cat quiz and starts over', async () => {
    block(catQuiz);
    expect(await screen.findByText('Question 1 of 3')).toBeInTheDocument();
    press('Yes', 'Yes', 'No');
    expect(await screen.findByText('You are a cat.')).toBeInTheDocument();
    press('Start over');
    expect(await screen.findByText('Question 1 of 3')).toBeInTheDocument();
    press('No', 'No', 'Yes');
    expect(await screen.findByText('You are probably not a cat.')).toBeInTheDocument();
  });
});

describe('what a block may do', () => {
  it('falls back to the source when nothing renders', async () => {
    block('root = Marquee("not a Nix component")');
    expect(await screen.findByText('fallback')).toBeInTheDocument();
  });

  it('links items only inside its own workspaces', async () => {
    const item = '22222222-2222-4222-8222-222222222222';
    const other = '33333333-3333-4333-8333-333333333333';
    block(
      `root = Stack([list])\nlist = ItemList([{id: "${item}", title: "Plan"}, {id: "${item}", title: "Elsewhere", workspaceId: "${other}"}])`,
    );
    expect(await screen.findByRole('link', { name: 'Plan' })).toHaveAttribute(
      'href',
      `/w/${workspace}?item=${item}`,
    );
    expect(screen.queryByRole('link', { name: 'Elsewhere' })).not.toBeInTheDocument();
    expect(screen.getByText('Elsewhere')).toBeInTheDocument();
  });

  it('passes an ask to the pet and never opens an outside URL', async () => {
    const onAsk = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    block(
      'root = Stack([ask, out])\nask = Button("Plan my week", Action([@ToAssistant("Plan my week")]))\nout = Button("Leave", Action([@OpenUrl("https://example.com")]))',
      onAsk,
    );
    await screen.findByRole('button', { name: 'Plan my week' });
    press('Plan my week');
    expect(onAsk).toHaveBeenCalledWith('Plan my week');
    press('Leave');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('renders inside pet replies from an openui-lang fence', async () => {
    render(
      <MemoryRouter>
        <PetMessageText
          workspaceId={workspace}
          text={`Here you go.\n\n\`\`\`openui-lang\n${catQuiz}\`\`\``}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Here you go.')).toBeInTheDocument();
    expect(await screen.findByText('Question 1 of 3')).toBeInTheDocument();
  });
});
