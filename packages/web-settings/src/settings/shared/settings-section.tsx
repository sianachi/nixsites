import { Text } from '@nix/ui';
import { useId, type ReactElement, type ReactNode } from 'react';

/** One settings section: a labelled region, its title, an optional one-line summary, then rows. */
export function SettingsSection(props: {
  readonly title: string;
  readonly summary?: string;
  readonly children: ReactNode;
}): ReactElement {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex max-w-2xl min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Text id={headingId} variant="h3" as="h2">
          {props.title}
        </Text>
        {props.summary === undefined ? null : (
          <Text variant="note" tone="muted">
            {props.summary}
          </Text>
        )}
      </div>
      {props.children}
    </section>
  );
}
