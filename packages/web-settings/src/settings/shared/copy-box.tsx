import { Button, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

/** A command or snippet with a Copy button that says in words whether the copy worked. */
export function CopyBox(props: { readonly text: string; readonly label: string }): ReactElement {
  const { text, label } = props;
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => {
      setState('idle');
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);

  function copy(): void {
    // jsdom and older browsers have no clipboard; say so instead of throwing.
    if (!('clipboard' in navigator)) {
      setState('failed');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => {
        setState('copied');
      },
      () => {
        setState('failed');
      },
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <pre
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable block needs a tab stop or its overflow cannot be reached without a pointer.
          tabIndex={0}
          className="min-w-0 flex-1 overflow-x-auto rounded-md border border-divider bg-surface p-3 font-mono text-sm"
        >
          {text}
        </pre>
        <Button type="button" variant="secondary" aria-label={`Copy ${label}`} onClick={copy}>
          {state === 'copied' ? 'Copied ✓' : 'Copy'}
        </Button>
      </div>
      <Text role={state === 'failed' ? 'alert' : 'status'} variant="caption" tone="muted">
        {state === 'copied'
          ? `Copied ${label}.`
          : state === 'failed'
            ? `Could not copy ${label}. Select it and copy by hand.`
            : ''}
      </Text>
    </div>
  );
}
