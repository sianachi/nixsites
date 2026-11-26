import { isCanceledError, pets, type PetUsageGroup, type PetUsageResponse } from '@nix/api-client';
import { Text } from '@nix/ui';
import { useEffect, useId, useState, type ReactElement } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

const usd = (value: number): string => `$${value.toFixed(2)}`;

const tokens = (group: PetUsageGroup): string =>
  (
    group.inputTokens +
    group.cacheReadTokens +
    group.cacheWriteTokens +
    group.outputTokens
  ).toLocaleString();

function Breakdown({
  title,
  groups,
}: {
  readonly title: string;
  readonly groups: readonly PetUsageGroup[];
}): ReactElement | null {
  if (groups.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <Text as="h4" variant="h6">
        {title}
      </Text>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {groups.map((group) => (
          <li key={group.key} className="flex min-w-0 flex-wrap justify-between gap-x-3">
            <Text as="span" truncate className="min-w-0">
              {group.key}
            </Text>
            <Text as="span" tone="muted" variant="note">
              {group.turns} {group.turns === 1 ? 'turn' : 'turns'} · {tokens(group)} tokens ·{' '}
              {usd(group.costUsd)}
            </Text>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The owner's own pet usage this month, with the budget the pets are held to. Costs are estimates
 * from a price table and, for OpenRouter, the price it reports. `refresh` changes when settings are
 * saved, so a new limit shows at once.
 */
export function PetUsagePanel({
  petNames,
  refresh,
}: {
  /** Pet id to name, so the by-pet list reads as names. */
  readonly petNames: Readonly<Record<string, string>>;
  readonly refresh: number;
}): ReactElement {
  const client = useApiClient();
  const headingId = useId();
  const [usage, setUsage] = useState<PetUsageResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    client
      .query(pets.usage(), { signal: controller.signal, forceRefresh: true })
      .then((response) => {
        if (controller.signal.aborted) return;
        setUsage(response);
        setFailed(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isCanceledError(cause)) return;
        setFailed(true);
      });
    return () => {
      controller.abort();
    };
  }, [client, refresh]);

  const budget = usage?.budget;
  const share =
    budget?.limitUsd != null && budget.limitUsd > 0
      ? Math.min(100, Math.round((budget.spentUsd / budget.limitUsd) * 100))
      : null;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <Text as="h3" id={headingId} variant="h5">
        Usage
      </Text>
      {failed ? <Text role="alert">Your pet usage could not be loaded.</Text> : null}
      {usage === null || budget === undefined ? (
        failed ? null : (
          <Text role="status" tone="muted">
            Loading usage…
          </Text>
        )
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-1">
            <Text role="status">
              {budget.limitUsd === null
                ? `${usd(budget.spentUsd)} used in ${budget.month}. No monthly limit is set.`
                : `${usd(budget.spentUsd)} of ${usd(budget.limitUsd)} used in ${budget.month}, ${usd(budget.remainingUsd ?? 0)} left.`}
            </Text>
            {share === null ? null : (
              <div
                role="progressbar"
                aria-label="Monthly pet budget used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={share}
                className="h-1.5 overflow-hidden rounded-full bg-surface-raised"
              >
                <div
                  className={`h-full transition-[width] duration-300 ease-out motion-reduce:transition-none ${share >= 100 ? 'bg-danger' : 'bg-accent'}`}
                  style={{ width: `${String(share)}%` }}
                />
              </div>
            )}
            {budget.remainingUsd === 0 && budget.limitUsd !== null ? (
              <Text variant="note" tone="muted">
                New pet turns are paused until next month. Raise the limit above to continue.
              </Text>
            ) : null}
          </div>
          <Text variant="note" tone="muted">
            {usage.total.turns} {usage.total.turns === 1 ? 'turn' : 'turns'} · {tokens(usage.total)}{' '}
            tokens this month. Costs are estimates; your provider&apos;s invoice is what counts.
            Your Claude or OpenRouter account also has its own spending limits for the key, set in
            the provider&apos;s console.
          </Text>
          <Breakdown title="By model" groups={usage.byModel} />
          <Breakdown title="By source" groups={usage.bySource} />
          <Breakdown
            title="By pet"
            groups={usage.byPet.map((group) => ({
              ...group,
              key: petNames[group.key] ?? 'A removed pet',
            }))}
          />
          <details>
            <summary className="cursor-pointer">
              <Text as="span">Day by day</Text>
            </summary>
            <Breakdown title="" groups={usage.days} />
          </details>
        </>
      )}
    </section>
  );
}
