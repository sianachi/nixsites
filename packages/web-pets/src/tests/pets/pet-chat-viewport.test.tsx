import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PetChatViewport } from '../../pets/pet-chat-viewport';

describe('pet conversation viewport', () => {
  it('keeps a keyboard-accessible message region separate from the composer', () => {
    render(
      <PetChatViewport latestKey="one">
        <p data-pet-latest-message="">A readable reply</p>
      </PetChatViewport>,
    );
    expect(screen.getByRole('log', { name: 'Conversation messages' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByText('A readable reply')).toBeVisible();
  });

  it('does not pull readers away from older messages when a reply arrives', async () => {
    const user = userEvent.setup();
    const view = render(
      <PetChatViewport latestKey="one">
        <p>Earlier reply</p>
      </PetChatViewport>,
    );
    const log = screen.getByRole('log');
    Object.defineProperties(log, { scrollHeight: { value: 1200 }, clientHeight: { value: 300 } });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    view.rerender(
      <PetChatViewport latestKey="two">
        <p>Earlier reply</p>
        <p data-pet-latest-message="">New reply</p>
      </PetChatViewport>,
    );
    expect(log.scrollTop).toBe(100);
    await user.click(screen.getByRole('button', { name: 'Show latest reply' }));
    expect(screen.queryByRole('button', { name: 'Show latest reply' })).not.toBeInTheDocument();
  });

  it('brings the beginning of a new response into view when following the chat', () => {
    const view = render(
      <PetChatViewport latestKey="one">
        <p>Earlier reply</p>
      </PetChatViewport>,
    );
    const log = screen.getByRole('log');
    log.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    view.rerender(
      <PetChatViewport latestKey="one">
        <p data-pet-latest-message="">A long reply</p>
      </PetChatViewport>,
    );
    screen.getByText('A long reply').getBoundingClientRect = () => ({ top: 700 }) as DOMRect;
    view.rerender(
      <PetChatViewport latestKey="two">
        <p data-pet-latest-message="">A long reply</p>
      </PetChatViewport>,
    );
    expect(log.scrollTop).toBe(600);
  });

  describe('with layout', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** The log is 400px tall at top 100; the latest reply starts 600px below the log's top
     * and moves up as the log scrolls, like a real layout. */
    function mockLayout(): void {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const log = document.querySelector<HTMLElement>('[role="log"]');
        if (this === log) return { top: 100, bottom: 500 } as DOMRect;
        if (log && this.hasAttribute('data-pet-latest-message'))
          return { top: 100 + 600 - log.scrollTop } as DOMRect;
        return { top: 0, bottom: 0 } as DOMRect;
      });
      Object.defineProperties(HTMLElement.prototype, {
        scrollHeight: { configurable: true, value: 2000 },
        clientHeight: { configurable: true, value: 400 },
      });
    }

    it('stays following after scrolling to the top of a tall reply, so no pill appears', () => {
      mockLayout();
      const view = render(
        <PetChatViewport latestKey="one">
          <p data-pet-latest-message="">A tall reply</p>
        </PetChatViewport>,
      );
      const log = screen.getByRole('log');
      expect(log.scrollTop).toBe(600);
      // The scroll event that the programmatic scroll causes.
      fireEvent.scroll(log);
      view.rerender(
        <PetChatViewport latestKey="two">
          <p data-pet-latest-message="">A tall reply</p>
        </PetChatViewport>,
      );
      expect(screen.queryByRole('button', { name: 'Show latest reply' })).not.toBeInTheDocument();
    });

    it('scrolls to your own message from further up, with the pill as an overlay', () => {
      mockLayout();
      const view = render(
        <PetChatViewport latestKey="one">
          <p data-pet-latest-message="">Earlier reply</p>
        </PetChatViewport>,
      );
      const log = screen.getByRole('log');
      log.scrollTop = 0;
      fireEvent.scroll(log);
      view.rerender(
        <PetChatViewport latestKey="two">
          <p>Earlier reply</p>
          <p data-pet-latest-message="">New reply</p>
        </PetChatViewport>,
      );
      const pill = screen.getByRole('button', { name: 'Show latest reply' });
      expect(pill).toHaveClass('absolute');
      view.rerender(
        <PetChatViewport latestKey="three">
          <p>Earlier reply</p>
          <p>New reply</p>
          <p data-pet-latest-message="" data-pet-from-user="">
            My message
          </p>
        </PetChatViewport>,
      );
      expect(log.scrollTop).toBe(600);
      expect(screen.queryByRole('button', { name: 'Show latest reply' })).not.toBeInTheDocument();
    });
  });
});
