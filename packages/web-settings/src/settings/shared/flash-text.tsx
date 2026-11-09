import { useFlash } from '@nix/ui';
import type { ReactElement, ReactNode } from 'react';

/** Tints its content once when `stamp` changes; `enter` also slides it in (a new row). */
export function FlashText(props: {
  readonly stamp: unknown;
  readonly enter?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  const flash = useFlash(props.stamp);
  return (
    <span
      className={props.className}
      {...flash}
      {...(props.enter === true ? { 'data-enter': '' } : {})}
    >
      {props.children}
    </span>
  );
}
