import { render } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useVirtualWindow } from '../../../collections/core/use-virtual-window';

function Harness(props: {
  readonly keys: readonly string[];
  readonly retainedIndexes: readonly number[];
}): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null);
  useVirtualWindow({
    keys: props.keys,
    retainedIndexes: props.retainedIndexes,
    rootRef,
    estimate: 40,
  });
  return <div ref={rootRef} />;
}

describe('useVirtualWindow subscriptions', () => {
  it('keeps observers and listeners across interaction-only rerenders', () => {
    const disconnect = vi.fn();
    const observers: unknown[] = [];
    class RecordingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        void callback;
        observers.push(this);
      }

      observe(target: Element): void {
        void target;
      }
      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const rendered = render(<Harness keys={['a', 'b', 'c']} retainedIndexes={[]} />);
    expect(observers).toHaveLength(1);

    rendered.rerender(<Harness keys={['a', 'b', 'c']} retainedIndexes={[2]} />);

    expect(observers).toHaveLength(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(add.mock.calls.filter(([event]) => event === 'scroll')).toHaveLength(1);
    expect(add.mock.calls.filter(([event]) => event === 'resize')).toHaveLength(1);
    expect(remove.mock.calls.filter(([event]) => event === 'scroll')).toHaveLength(0);
    expect(remove.mock.calls.filter(([event]) => event === 'resize')).toHaveLength(0);

    rendered.rerender(<Harness keys={['a', 'c', 'b']} retainedIndexes={[2]} />);

    expect(observers).toHaveLength(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.filter(([event]) => event === 'scroll')).toHaveLength(1);
    expect(remove.mock.calls.filter(([event]) => event === 'resize')).toHaveLength(1);
  });
});
