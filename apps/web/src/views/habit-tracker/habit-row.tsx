import { Button, ContextMenu, cn, focusRing, Icon, Input, Text } from '@nix/ui';
import { Check, CheckCircle2, Circle, CircleAlert, Clock3, Pencil } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useItemOpenProps } from '../../collections/core/item-open-click';
import { SelectCheckbox } from '../core/select-checkbox';
import { useItemContextActions } from '../../collections/core/use-item-context-actions';
import type { HabitTracker } from '@nix/api-client';
import { spokenDayName, todayInTimezone, weekdayFor } from './habit-days';

export function HabitRow({
  itemId,
  title,
  days,
  tracker,
  onOpen,
  onSave,
  onUndo,
  onEdit,
  onStatus,
}: {
  readonly itemId: string;
  readonly title: string;
  readonly days: readonly string[];
  readonly tracker: HabitTracker;
  readonly onOpen: (id: string) => void;
  readonly onSave: (
    id: string,
    day: string,
    completed: boolean,
    quantity: number | null,
  ) => Promise<string | null>;
  readonly onUndo: (id: string, day: string) => Promise<string | null>;
  readonly onEdit: () => void;
  readonly onStatus: (
    id: string,
    status: 'active' | 'paused' | 'archived',
  ) => Promise<string | null>;
}): ReactNode {
  const itemActions = useItemContextActions(onOpen);
  const openProps = useItemOpenProps(onOpen);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [statusPending, setStatusPending] = useState(false);
  const compact = days.length > 1;
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Readonly<Record<string, string>>>({});
  // A day's completion, as tapped, ahead of the write and the refetch that confirms it. Cleared
  // once the tracker prop itself agrees, or rolled back on a refusal - see the render-time
  // adjustment below and `act`.
  const [optimistic, setOptimistic] = useState<Readonly<Record<string, boolean>>>({});
  const checkIns = new Map(tracker.checkIns.map((entry) => [entry.occurredOn, entry]));
  const occurrenceMap = new Map((tracker.occurrences ?? []).map((entry) => [entry.date, entry]));
  const lifecycle = tracker.status;
  // Adjusted during render rather than in an effect: a fresh `tracker` (the only thing that can
  // confirm an optimistic tick) has to drop any tick it now agrees with before this render paints,
  // not one render later. React re-renders immediately when state changes mid-render this way, so
  // there is no flash of the newly-confirmed tick reverting first.
  const [previousTracker, setPreviousTracker] = useState(tracker);
  if (previousTracker !== tracker) {
    setPreviousTracker(tracker);
    if (Object.keys(optimistic).length > 0) {
      const confirmed = Object.entries(optimistic).filter(([day, expected]) => {
        const entry = tracker.checkIns.find((candidate) => candidate.occurredOn === day);
        const occurrence = (tracker.occurrences ?? []).find((candidate) => candidate.date === day);
        const actual = occurrence?.completed ?? entry?.completed === true;
        return actual !== expected;
      });
      if (confirmed.length !== Object.keys(optimistic).length) {
        setOptimistic(Object.fromEntries(confirmed));
      }
    }
  }
  return (
    <tr
      className={
        compact
          ? 'grid grid-cols-7 border-b border-divider @lg:table-row'
          : 'block border-b border-divider @lg:table-row'
      }
    >
      <th
        scope="row"
        className={
          compact
            ? 'col-span-7 p-3 text-left align-top @lg:sticky @lg:left-0 @lg:z-10 @lg:table-cell @lg:min-w-40 @lg:bg-background'
            : 'block p-3 text-left align-middle @lg:table-cell'
        }
      >
        <ContextMenu
          label={`${title || 'Untitled habit'} actions`}
          items={() =>
            itemActions(itemId, title, [
              { kind: 'action', label: 'Edit schedule', onSelect: onEdit },
            ])
          }
        >
          {(contextTarget) => (
            <div
              {...contextTarget}
              className="group flex min-w-0 items-start justify-between gap-3"
            >
              <SelectCheckbox item={{ id: itemId, title }} className="mt-1" />
              <div className="min-w-0 flex-1">
                <Button
                  variant="ghost"
                  className="max-w-full justify-start truncate px-0 text-left text-lg font-semibold"
                  aria-label={`Open ${title || 'Untitled habit'}`}
                  {...openProps(itemId)}
                >
                  {title || 'Untitled habit'}
                </Button>
                <Text variant="caption" tone="muted">
                  {tracker.target === 1 && tracker.unit === 'times'
                    ? 'Check-in'
                    : `Goal: ${String(tracker.target)} ${tracker.unit}`}
                </Text>
              </div>
              {lifecycle !== 'active' ? (
                <Text variant="caption" tone="muted" className="capitalize">
                  {lifecycle}
                </Text>
              ) : null}
              <button
                type="button"
                aria-label={`Edit ${title || 'Untitled habit'}`}
                className={cn(
                  'inline-flex size-(--control-sm) shrink-0 items-center justify-center text-muted hover:text-foreground any-pointer-coarse:size-(--control-lg)',
                  focusRing,
                )}
                onClick={onEdit}
              >
                <Icon icon={Pencil} size="sm" />
              </button>
            </div>
          )}
        </ContextMenu>
        <details className="mt-1">
          <summary
            className={cn(
              'w-fit cursor-default rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-surface-raised any-pointer-coarse:min-h-(--control-lg)',
              focusRing,
            )}
          >
            Habit options
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-1 rounded-md bg-surface-raised p-2">
            <Text variant="caption" tone="muted" className="px-2 capitalize">
              Status: {lifecycle}
            </Text>
            {lifecycle !== 'archived' ? (
              <Button
                variant="ghost"
                disabled={statusPending}
                onClick={() => {
                  setStatusPending(true);
                  void onStatus(itemId, lifecycle === 'paused' ? 'active' : 'paused').then(
                    (result) => {
                      setMessage(result);
                      setStatusPending(false);
                    },
                  );
                }}
              >
                {statusPending ? 'Saving' : lifecycle === 'paused' ? 'Resume' : 'Pause'}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={statusPending}
              onClick={() => {
                setStatusPending(true);
                void onStatus(itemId, lifecycle === 'archived' ? 'active' : 'archived').then(
                  (result) => {
                    setMessage(result);
                    setStatusPending(false);
                  },
                );
              }}
            >
              {lifecycle === 'archived' ? 'Restore' : 'Archive'}
            </Button>
          </div>
        </details>
        {message ? (
          <Text variant="note" role="alert">
            {message}
          </Text>
        ) : null}
      </th>
      {days.map((day) => {
        const entry = checkIns.get(day);
        const occurrence = occurrenceMap.get(day);
        const scheduled =
          occurrence?.scheduled ??
          (day >= tracker.startDate &&
            (tracker.frequency === 'daily' || tracker.weekdays.includes(weekdayFor(day))));
        const future = day > todayInTimezone(tracker.timezone);
        const hasEntry = entry !== undefined;
        const actual = occurrence?.completed ?? entry?.completed === true;
        // The optimistic tap wins over the last confirmed read until either the refetch this row
        // triggered agrees (the effect above clears it) or the write it followed is refused.
        const checked = optimistic[day] ?? actual;
        const stateLabel = future
          ? 'upcoming'
          : checked
            ? 'completed'
            : (occurrence?.state ??
              (hasEntry
                ? 'partial'
                : day === todayInTimezone(tracker.timezone)
                  ? 'scheduled'
                  : 'missed'));
        const key = `${itemId}:${day}`;
        const quantity =
          quantities[day] ??
          (entry?.quantity === null || entry?.quantity === undefined ? '' : String(entry.quantity));
        const target = occurrence?.target ?? tracker.target;
        const unit = occurrence?.unit ?? tracker.unit;
        const measured = target !== 1 || unit !== 'times';
        const invalidQuantity =
          measured &&
          (quantity.trim() === '' ||
            !Number.isFinite(Number(quantity)) ||
            Number(quantity) < 0 ||
            Number(quantity) > 1_000_000);
        const act = async (undo: boolean): Promise<void> => {
          setOptimistic((current) => ({
            ...current,
            [day]: !undo && (!measured || Number(quantity) >= target),
          }));
          setPending((current) => new Set(current).add(key));
          const refusal = undo
            ? await onUndo(itemId, day)
            : await onSave(itemId, day, true, measured ? Number(quantity) : null);
          setPending((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
          if (refusal === null) {
            setQuantities((current) => {
              return Object.fromEntries(
                Object.entries(current).filter(([entryDay]) => entryDay !== day),
              );
            });
          } else {
            // The write was refused: the tap never happened as far as Core is concerned, so the
            // tick comes back off rather than sitting there until some later refetch disagrees
            // with it.
            setOptimistic((current) =>
              Object.fromEntries(Object.entries(current).filter(([entryDay]) => entryDay !== day)),
            );
          }
          setMessage(refusal);
        };
        return (
          <td
            key={day}
            className={cn(
              compact
                ? cn('p-0.5 text-center align-top @lg:p-2', selectedDay === day && 'col-span-7')
                : 'block p-3 align-middle @lg:table-cell',
              day === todayInTimezone(tracker.timezone) && compact && 'bg-accent/10',
            )}
          >
            {compact && selectedDay !== day ? (
              <Button
                variant={checked ? 'primary' : 'ghost'}
                className="h-(--control-md) w-full min-w-0 p-0 any-pointer-coarse:h-(--control-lg) @lg:w-(--control-md) any-pointer-coarse:@lg:w-(--control-lg)"
                disabled={future || (!scheduled && !hasEntry)}
                aria-busy={pending.has(key) || undefined}
                aria-label={`${title}, ${spokenDayName(day)}, ${future ? 'upcoming' : checked ? 'done' : scheduled ? 'not done' : 'not scheduled'}`}
                aria-pressed={checked}
                title={`${day}: ${future ? 'Upcoming' : stateLabel}${entry?.quantity == null ? '' : `, ${String(entry.quantity)}/${String(target)} ${unit}`}`}
                onClick={() => {
                  // Not `disabled` while saving: that would drop focus to the body after each tap.
                  if (pending.has(key)) return;
                  // A plain habit is one tap; a measured one needs its quantity first.
                  if (measured || lifecycle !== 'active') setSelectedDay(day);
                  else void act(checked);
                }}
              >
                {checked ? (
                  <Check size={18} aria-hidden="true" />
                ) : !scheduled ? (
                  <Text as="span" variant="caption">
                    —
                  </Text>
                ) : stateLabel === 'partial' ? (
                  <Clock3 size={18} aria-hidden="true" />
                ) : stateLabel === 'missed' ? (
                  <CircleAlert size={18} aria-hidden="true" />
                ) : (
                  <Circle size={18} aria-hidden="true" />
                )}
              </Button>
            ) : scheduled || hasEntry ? (
              <div className="flex flex-wrap items-center justify-start gap-2 @lg:justify-end">
                {measured ? (
                  <Input
                    aria-label={`${title}, ${day}, quantity`}
                    className="w-24"
                    type="number"
                    min="0"
                    step="any"
                    value={quantity}
                    disabled={pending.has(key) || future || lifecycle !== 'active'}
                    onChange={(event) => {
                      setQuantities((current) => ({ ...current, [day]: event.target.value }));
                    }}
                  />
                ) : null}
                <Button
                  variant={checked ? 'primary' : 'secondary'}
                  disabled={pending.has(key) || future || invalidQuantity || lifecycle !== 'active'}
                  aria-label={
                    measured
                      ? `Save ${title}, ${day}, quantity`
                      : `${checked ? 'Done: undo check-in for' : 'Check in'} ${title}, ${day}${future ? ', upcoming' : ''}`
                  }
                  aria-pressed={checked}
                  onClick={() => {
                    void act(!measured && checked);
                  }}
                >
                  {!measured && checked ? <Check size={18} aria-hidden="true" /> : null}
                  {pending.has(key) ? 'Saving' : measured ? 'Save' : checked ? 'Done' : 'Check in'}
                </Button>
                <Text
                  variant="caption"
                  tone="muted"
                  className="inline-flex items-center gap-1 capitalize"
                >
                  <span aria-hidden="true">
                    {stateLabel === 'completed' ? (
                      <CheckCircle2 size={14} />
                    ) : stateLabel === 'missed' ? (
                      <CircleAlert size={14} />
                    ) : stateLabel === 'partial' ? (
                      <Clock3 size={14} />
                    ) : (
                      <Circle size={14} />
                    )}
                  </span>
                  {stateLabel === 'scheduled'
                    ? 'Due today'
                    : stateLabel === 'missed'
                      ? 'No check-in'
                      : stateLabel === 'partial'
                        ? 'Partly done'
                        : stateLabel}
                </Text>
                {measured && hasEntry ? (
                  <Button
                    variant="ghost"
                    disabled={pending.has(key) || future || lifecycle !== 'active'}
                    aria-label={`Undo ${title}, ${day}`}
                    onClick={() => {
                      void act(true);
                    }}
                  >
                    Undo
                  </Button>
                ) : null}
                {measured && entry ? (
                  <Text variant="caption" tone="muted">
                    {`${String(entry.quantity ?? 0)}/${String(target)} ${unit}`}
                  </Text>
                ) : null}
                {compact ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSelectedDay(null);
                    }}
                  >
                    Close
                  </Button>
                ) : null}
              </div>
            ) : (
              <Text variant="caption" tone="muted">
                Not scheduled
              </Text>
            )}
          </td>
        );
      })}
    </tr>
  );
}
