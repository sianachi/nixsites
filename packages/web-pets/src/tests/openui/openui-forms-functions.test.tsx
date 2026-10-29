import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OpenUiBlock from '../../openui/openui-block';

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

afterEach(() => {
  vi.useRealTimers();
});

describe('date functions', () => {
  it('count days from today and read a day aloud', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T12:00:00'));
    block(
      'root = Stack([left, eve, bad])\nleft = Stat("Days to Christmas", @DaysBetween(@Today(), "2026-12-25"))\neve = Text(@FormatDate(@AddDays("2026-12-25", -1), "weekday"))\nbad = Text(@DaysBetween("soon", "2026-12-25") == null ? "no date" : "date")',
    );
    expect(await screen.findByText('67')).toBeInTheDocument();
    expect(screen.getByText('Thursday')).toBeInTheDocument();
    expect(screen.getByText('no date')).toBeInTheDocument();
  });
});

describe('forms', () => {
  const signup = `root = Stack([form])
form = Form("Sign up", join, [name, age, terms])
name = TextInput("Name", $name, "Your name", {required: true, minLength: 2})
age = NumberInput("Age", $age, 0, 120, 1, {min: 18})
terms = Toggle("I agree", $terms, {required: true})
join = Button("Join", @ToAssistant("joined"), "primary")
$name = ""
$age = 10
$terms = false`;

  it('blocks submit until every rule passes, then runs the action', async () => {
    const onAsk = vi.fn();
    block(signup, onAsk);
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    expect(onAsk).not.toHaveBeenCalled();
    expect(await screen.findByText('Must be at least 18')).toBeInTheDocument();
    expect(screen.getAllByText('This field is required')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/Age/), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('I agree'));
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onAsk).toHaveBeenCalledWith('joined');
  });

  it('clears an error as soon as the field is fixed', async () => {
    block(signup, vi.fn());
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    expect(await screen.findByText('Must be at least 18')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Age/), { target: { value: '21' } });
    expect(screen.queryByText('Must be at least 18')).not.toBeInTheDocument();
  });
});
