import { CircleAlert, Inbox, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';

import { Blueprint, Icon, Skeleton, Text } from '@nix/ui';

/**
 * The honest states, as reusable panels. Every data-bearing view in the app
 * reaches for these rather than inventing its own placeholder, so the
 * vocabulary users learn stays constant and no view can quietly skip a state.
 *
 * Accessibility, decided once here:
 *   - LoadingPanel is a polite live region with `aria-busy`, and it names what
 *     it is waiting for. A spinner with no name is not a state, it is a shrug.
 *   - ErrorPanel is `role="alert"`, so a failure is announced, and it renders
 *     its recovery affordance whenever one exists.
 *   - EmptyPanel and PartialNotice are `role="status"`: information, not an
 *     interruption.
 *
 * Each panel is a blueprint object - hairline frame, registration marks, no
 * fill - so a state placeholder sits in the page as a first-class object
 * rather than as grey filler.
 */

function PanelFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return <Blueprint className="p-6">{children}</Blueprint>;
}

const PANEL_BODY = 'flex flex-col items-start gap-3';

/**
 * How long a load may take before the panel says so in words. Most loads land well inside it, and
 * for those the shapes alone are the better answer: text that flashes up and is replaced a moment
 * later reads as a page load, where shapes filling in read as an application. Past it, the wait is
 * long enough that someone deserves to be told nothing has failed.
 */
export const LOADING_EXPLANATION_DELAY_MS = 2_000;

export function LoadingPanel({ label }: { readonly label: string }): ReactElement {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSlow(true);
    }, LOADING_EXPLANATION_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  return (
    <PanelFrame>
      <div aria-busy={true} aria-live="polite" className={PANEL_BODY}>
        {/* Announced at once either way; shown in words only once the wait is a long one, under
            the same shapes, so the panel adds a sentence rather than swapping its layout. */}
        <Text variant="h3" className={slow ? '' : 'sr-only'}>
          Loading {label}
        </Text>
        <div className="flex w-full flex-col gap-3">
          <Skeleton shape="heading" className="w-1/3" />
          <Skeleton className="w-full" />
          <Skeleton className="w-5/6" />
          <Skeleton className="w-2/3" />
        </div>
        {slow ? (
          <Text tone="muted">
            Waiting on {label}. Nothing has failed; this view will change on its own.
          </Text>
        ) : null}
      </div>
    </PanelFrame>
  );
}

export function EmptyPanel({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <PanelFrame>
      <div role="status" className={PANEL_BODY}>
        <Icon icon={Inbox} className="text-accent" />
        <Text variant="h3">{title}</Text>
        <Text tone="muted">{detail}</Text>
        {action}
      </div>
    </PanelFrame>
  );
}

export function ErrorPanel({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <PanelFrame>
      <div role="alert" className={PANEL_BODY}>
        <Icon icon={CircleAlert} className="text-accent" />
        <Text variant="h3">{title}</Text>
        <Text tone="muted">{detail}</Text>
        {action}
      </div>
    </PanelFrame>
  );
}

/**
 * Rendered alongside real content, never instead of it: what is on screen is
 * usable, and this says which part of it is not ready yet.
 */
export function PartialNotice({
  pending,
  action,
}: {
  readonly pending: string;
  /** Where the missing part is put right, when there is somewhere to send somebody. */
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <div role="status" className="flex items-start gap-2 border border-divider p-3">
      <Icon icon={TriangleAlert} className="size-4 text-accent-text" />
      <div className="flex flex-col items-start gap-1">
        <Text variant="note" as="span" tone="accent">
          {pending}
        </Text>
        {action}
      </div>
    </div>
  );
}
