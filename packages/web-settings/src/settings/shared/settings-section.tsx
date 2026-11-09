import { Text } from '@nix/ui';
import { useId, type ReactElement, type ReactNode } from 'react';

/** One settings section: a labelled region, its title, an optional one-line summary, then rows. */
export function SettingsSection(props: {
  readonly title: string;
  readonly summary?: string;
  /** Who the changes reach, as a caption under the summary. */
  readonly scope?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex max-w-2xl min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1 max-sm:px-3">
        <Text id={headingId} variant="h3" as="h2">
          {props.title}
        </Text>
        {props.summary === undefined ? null : (
          <Text variant="note" tone="muted">
            {props.summary}
          </Text>
        )}
        {props.scope}
      </div>
      {/* Phone: the rows become one grouped, rounded card; sm and up is unchanged. */}
      <div className="flex flex-col gap-4 max-sm:rounded-card max-sm:bg-surface-raised max-sm:p-3">
        {props.children}
      </div>
    </section>
  );
}
