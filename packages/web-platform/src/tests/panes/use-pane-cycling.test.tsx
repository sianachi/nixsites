import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import { paneElementId } from '../../panes/pane-params';
import { usePaneCycling } from '../../panes/use-pane-cycling';

/**
 * F6 as the key between regions.
 *
 * The harness stands in for the editor page: one region per pane, carrying the id `focusPane`
 * already addresses and the programmatic tab stop a real pane region has, with a control inside
 * so the tests can start from "focus is somewhere deep in a pane" - which is exactly the position
 * the key exists to rescue.
 */

function Harness({
  count,
  refusesFocus = false,
}: {
  readonly count: number;

  /**
   * Regions that will not take focus, standing in for the modal case.
   *
   * A real `<Dialog>` covers the panes with `showModal`, which makes everything behind it inert,
   * and `.focus()` on an inert element is a silent no-op. jsdom implements the `inert` attribute
   * as markup only - focus lands on inert elements there quite happily - so the refusal is
   * expressed the one way jsdom does honour: a region with no tab stop at all. What is under test
   * is the hook's response to a region that did not take focus, which is the same either way.
   */
  readonly refusesFocus?: boolean;
}): ReactNode {
  usePaneCycling(count);

  return (
    <div>
      <button type="button">toolbar</button>
      {Array.from({ length: count }, (_, index) => (
        <article
          key={index}
          id={paneElementId(index)}
          tabIndex={refusesFocus ? undefined : -1}
          aria-label={`Pane ${String(index + 1)} of ${String(count)}`}
        >
          <button type="button">{`open ${String(index + 1)}`}</button>
        </article>
      ))}
    </div>
  );
}

function pane(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

describe('cycling the panes with F6', () => {
  it('moves focus from inside one pane to the next pane region', async () => {
    const user = userEvent.setup();
    render(<Harness count={3} />);

    screen.getByRole('button', { name: 'open 1' }).focus();
    await user.keyboard('{F6}');

    expect(pane('Pane 2 of 3')).toHaveFocus();
  });

  it('wraps from the last pane back to the first', async () => {
    const user = userEvent.setup();
    render(<Harness count={3} />);

    screen.getByRole('button', { name: 'open 3' }).focus();
    await user.keyboard('{F6}');

    expect(pane('Pane 1 of 3')).toHaveFocus();
  });

  it('moves backwards with Shift held, wrapping off the front', async () => {
    const user = userEvent.setup();
    render(<Harness count={3} />);

    screen.getByRole('button', { name: 'open 2' }).focus();
    await user.keyboard('{Shift>}{F6}{/Shift}');
    expect(pane('Pane 1 of 3')).toHaveFocus();

    await user.keyboard('{Shift>}{F6}{/Shift}');
    expect(pane('Pane 3 of 3')).toHaveFocus();
  });

  it('enters at the first pane when focus is outside every pane', async () => {
    const user = userEvent.setup();
    render(<Harness count={2} />);

    screen.getByRole('button', { name: 'toolbar' }).focus();
    await user.keyboard('{F6}');

    expect(pane('Pane 1 of 2')).toHaveFocus();
  });

  it('enters at the last pane when travelling backwards from outside', async () => {
    const user = userEvent.setup();
    render(<Harness count={2} />);

    screen.getByRole('button', { name: 'toolbar' }).focus();
    await user.keyboard('{Shift>}{F6}{/Shift}');

    expect(pane('Pane 2 of 2')).toHaveFocus();
  });

  it('leaves F6 to a modal dialog that is covering the panes', () => {
    // Focus cannot enter a region behind a modal, so claiming the key there would take F6 away
    // from the dialog while moving nothing at all. The key is claimed on the outcome - did the
    // region end up with focus - and never on the intention. See the harness for how the refusal
    // is expressed, since jsdom does not implement `inert`'s focus behaviour.
    //
    // Asserted on `defaultPrevented` rather than on where focus ended up: focus staying put is
    // true whether or not the handler swallowed the key, so a "focus is unchanged" assertion
    // passes just as happily with the `preventDefault` back above the outcome check - which is
    // the regression this test exists to catch. Whether the key was consumed is the contract.
    render(<Harness count={3} refusesFocus />);

    screen.getByRole('button', { name: 'toolbar' }).focus();
    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('consumes F6 when the move it makes actually happens', () => {
    // The other side of the assertion above: the key is swallowed exactly when it did something,
    // so the two together pin the ordering rather than only one direction of it.
    render(<Harness count={3} />);

    screen.getByRole('button', { name: 'open 1' }).focus();
    const event = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(pane('Pane 2 of 3')).toHaveFocus();
  });

  it('leaves F6 alone while only one pane is open', async () => {
    // A key that is swallowed while visibly doing nothing reads as broken, so a single pane does
    // not claim it - the browser may have its own use for F6.
    const user = userEvent.setup();
    render(<Harness count={1} />);

    const toolbar = screen.getByRole('button', { name: 'toolbar' });
    toolbar.focus();
    await user.keyboard('{F6}');

    expect(toolbar).toHaveFocus();
  });

  it('leaves a modified F6 to the browser', async () => {
    const user = userEvent.setup();
    render(<Harness count={2} />);

    const inside = screen.getByRole('button', { name: 'open 1' });
    inside.focus();
    await user.keyboard('{Control>}{F6}{/Control}');

    expect(inside).toHaveFocus();
  });
});
