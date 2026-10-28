import type { ReactElement, ReactNode } from 'react';

import type { AsyncStatus } from '../../lib/async-status';
import { Button } from '@nix/ui';
import { EmptyPanel, ErrorPanel, LoadingPanel, PartialNotice } from './status-panels';

/**
 * Renders an AsyncStatus. This is the seam that makes state honesty
 * structural: a view hands over its status and gets the matching state back,
 * and the `never` in the exhaustiveness check means adding a state to the
 * union breaks the build here rather than silently rendering nothing.
 *
 * `partial` renders the children *and* the notice - the data is real and
 * usable, and the user is told what is still missing. That is the difference
 * between a truthful view and one that quietly pretends to be complete.
 */

interface AsyncSectionProps<T> {
  readonly status: AsyncStatus<T>;
  readonly children: (value: T) => ReactNode;
}

export function AsyncSection<T>({ status, children }: AsyncSectionProps<T>): ReactElement {
  switch (status.kind) {
    case 'loading':
      return <LoadingPanel label={status.label} />;

    case 'empty':
      return <EmptyPanel title={status.title} detail={status.detail} />;

    case 'error': {
      const retry = status.retry;
      return (
        <ErrorPanel
          title={status.title}
          detail={status.detail}
          action={retry === undefined ? undefined : <Button onClick={retry}>Try again</Button>}
        />
      );
    }

    case 'partial':
      return (
        <div className="flex flex-col gap-4">
          <PartialNotice pending={status.pending} />
          {children(status.value)}
        </div>
      );

    case 'ready':
      return <>{children(status.value)}</>;

    default: {
      const unreachable: never = status;
      return <>{String(unreachable)}</>;
    }
  }
}
