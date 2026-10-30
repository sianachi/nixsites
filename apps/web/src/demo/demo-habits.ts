// Habits for the server-free demo: a few daily habits with a month of check-ins, answering the
// habit endpoints from memory. Core does the calendar maths in the real app; here the tracker
// carries only what the view cannot work out for itself (check-ins and the streak figures).
type Json = Record<string, unknown>;

export interface DemoHabit {
  readonly id: string;
  readonly target: number;
  readonly unit: string;
}

interface Settings {
  frequency: string;
  weekdays: number[];
  timezone: string;
  startDate: string;
  target: number;
  unit: string;
  reminderTime: string | null;
}

interface CheckIn {
  completed: boolean;
  quantity: number | null;
}

type Route = [
  string,
  RegExp,
  (
    request: { readonly body: unknown; readonly query: URLSearchParams },
    match: RegExpMatchArray,
  ) => Response | null,
];

const SEEDED_DAYS = 40;

/** A local calendar day `offset` days from today, as YYYY-MM-DD. */
function dayAt(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** A stable UUID for one habit's check-in on one day, as the schema expects one. */
function checkInId(habitId: string, day: string): string {
  const n =
    (Number.parseInt(habitId.slice(-4), 16) % 4096) * 100_000 +
    Date.parse(`${day}T00:00:00Z`) / 86_400_000;
  return `0199a000-0000-7000-8000-${Math.round(n).toString(16).padStart(12, '0')}`;
}

export function createDemoHabits(env: {
  readonly habits: readonly DemoHabit[];
  readonly json: (value: unknown, status?: number) => Response;
}): Route[] {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const settings = new Map<string, Settings>();
  const status = new Map<string, string>();
  const checkIns = new Map<string, Map<string, CheckIn>>();

  env.habits.forEach((habit, index) => {
    settings.set(habit.id, {
      frequency: 'daily',
      weekdays: [],
      timezone,
      startDate: dayAt(-SEEDED_DAYS),
      target: habit.target,
      unit: habit.unit,
      reminderTime: null,
    });
    status.set(habit.id, 'active');
    const days = new Map<string, CheckIn>();
    // Yesterday backwards; today is left for the visitor, except the first habit, already done.
    for (let back = 1; back <= SEEDED_DAYS; back++) {
      // A miss every few days, offset per habit so the grid is not striped in lockstep.
      if (back > 3 && (back + index * 2) % (5 + index) === 0) continue;
      const partial = habit.target > 1 && back > 3 && (back + index) % 7 === 0;
      days.set(dayAt(-back), {
        completed: !partial,
        quantity: habit.target > 1 ? (partial ? habit.target - 3 : habit.target) : null,
      });
    }
    if (index === 0) days.set(dayAt(0), { completed: true, quantity: null });
    checkIns.set(habit.id, days);
  });

  const streaks = (days: Map<string, CheckIn>): [number, number] => {
    let best = 0;
    let run = 0;
    for (let offset = -SEEDED_DAYS; offset <= 0; offset++) {
      if (days.get(dayAt(offset))?.completed === true) {
        run += 1;
        best = Math.max(best, run);
      } else if (offset < 0) run = 0; // today unchecked neither extends nor breaks the run
    }
    return [run, best];
  };

  const tracker = (id: string, from: string, to: string): Json | null => {
    const own = settings.get(id);
    const days = checkIns.get(id);
    if (own === undefined || days === undefined) return null;
    const done = [...days].filter(([date, entry]) => date < dayAt(0) && entry.completed).length;
    const [currentStreak, bestStreak] = streaks(days);
    return {
      habitId: id,
      ...own,
      status: status.get(id) ?? 'active',
      checkIns: [...days]
        .filter(([date]) => date >= from && date <= to)
        .map(([date, entry]) => ({ id: checkInId(id, date), occurredOn: date, ...entry })),
      weeks: [],
      occurrences: null,
      months: null,
      progress: {
        currentStreak,
        bestStreak,
        planned: SEEDED_DAYS,
        completed: done,
        completionRate: done / SEEDED_DAYS,
        quantity: 0,
      },
    };
  };

  const field = (body: unknown, key: string): unknown =>
    typeof body === 'object' && body !== null ? (body as Json)[key] : undefined;

  return [
    [
      'GET',
      /^\/api\/v1\/items\/([^/]+)\/habit$/,
      ({ query }, [, id]) => {
        const read = tracker(id ?? '', query.get('from') ?? dayAt(-6), query.get('to') ?? dayAt(0));
        return read === null ? null : env.json(read);
      },
    ],
    [
      'PUT',
      /^\/api\/v1\/items\/([^/]+)\/habit$/,
      ({ body }, [, id]) => {
        const own = settings.get(id ?? '');
        if (own === undefined || id === undefined) return null;
        Object.assign(own, {
          frequency: field(body, 'frequency') ?? own.frequency,
          unit: field(body, 'unit') ?? own.unit,
          target: field(body, 'target') ?? own.target,
        });
        return env.json(tracker(id, dayAt(0), dayAt(0)));
      },
    ],
    [
      'PUT',
      /^\/api\/v1\/items\/([^/]+)\/habit\/check-ins\/([^/]+)$/,
      ({ body }, [, id, day]) => {
        const days = checkIns.get(id ?? '');
        if (id === undefined || days === undefined || day === undefined) return null;
        const quantity = field(body, 'quantity');
        const entry = {
          completed: field(body, 'completed') === true,
          quantity: typeof quantity === 'number' ? quantity : null,
        };
        days.set(day, entry);
        return env.json({ id: checkInId(id, day), occurredOn: day, ...entry });
      },
    ],
    [
      'DELETE',
      /^\/api\/v1\/items\/([^/]+)\/habit\/check-ins\/([^/]+)$/,
      (_, [, id, day]) => {
        const days = checkIns.get(id ?? '');
        if (days === undefined || day === undefined) return null;
        days.delete(day);
        return new Response(null, { status: 204 });
      },
    ],
    [
      'PUT',
      /^\/api\/v1\/items\/([^/]+)\/habit\/status$/,
      ({ body }, [, id]) => {
        if (id === undefined || !settings.has(id)) return null;
        const next = field(body, 'status');
        status.set(id, typeof next === 'string' ? next : 'active');
        return env.json({ habitId: id, status: status.get(id) });
      },
    ],
  ];
}
