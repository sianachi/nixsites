import {
  createNixClient,
  type HabitTracker,
  type Workspace,
  type QueryEndpoint,
  type CommandEndpoint,
  type NixClient,
} from '@nix/api-client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useState, type ReactElement } from 'react';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { WorkspaceProvider } from '../../workspaces/workspace-context';
import type { ContainerData } from '../core/use-container';
import type { View } from '../core/container-model';
import { ContainerView } from '../core/container-view';
import { HabitInsights } from './habit-insights';
import { habitDateRange, habitDays, shiftHabitDay } from './habit-progress';
import { formatShortDate } from '@nix/web-foundation/lib/date-format';

const today = formatShortDate(new Date(), 'Europe/London');
const HABIT = 'd1111111-1111-4111-8111-111111111111';
const WATER = 'd2222222-2222-4222-8222-222222222222';
const PAUSED = 'd3333333-3333-4333-8333-333333333333';
const WORKSPACE = 'd4444444-4444-4444-8444-444444444444';
const noop = () => undefined;
const saved = () => Promise.resolve(null);
const editedCheckIns = new Map<string, { completed: boolean; quantity: number | null } | null>();
const statuses = new Map<string, 'active' | 'paused' | 'archived'>();
const base: HabitTracker = {
  habitId: HABIT,
  frequency: 'daily',
  weekdays: [],
  timezone: 'Europe/London',
  startDate: shiftHabitDay(today, -150),
  target: 1,
  unit: 'times',
  status: 'active',
  reminderTime: null,
  checkIns: [],
  weeks: [],
  occurrences: null,
  months: [],
  progress: {
    currentStreak: 4,
    bestStreak: 12,
    planned: 30,
    completed: 23,
    completionRate: 23 / 30,
    quantity: 0,
  },
};
function storyTracker(
  id: string,
  from = shiftHabitDay(today, -150),
  to = today,
  empty = false,
): HabitTracker {
  const tracker = {
    ...base,
    habitId: id,
    target: id === WATER ? 8 : 1,
    unit: id === WATER ? 'glasses' : 'times',
    status: statuses.get(id) ?? (id === PAUSED ? ('paused' as const) : ('active' as const)),
  };
  const seeded = empty
    ? []
    : habitDateRange(from, to).flatMap((date, index) =>
        date > today || id === PAUSED || index % 6 === 0
          ? []
          : [
              {
                id: `${id}-${date}`,
                occurredOn: date,
                completed: index % 5 !== 0,
                quantity: id === WATER ? (index % 5 === 0 ? 5 : 8 + (index % 3)) : null,
              },
            ],
      );
  const checkIns = habitDateRange(from, to).flatMap((date) => {
    const key = `${id}:${date}`;
    if (editedCheckIns.has(key)) {
      const edited = editedCheckIns.get(key);
      return edited == null ? [] : [{ id: key, occurredOn: date, ...edited }];
    }
    const entry = seeded.find((candidate) => candidate.occurredOn === date);
    return entry === undefined ? [] : [entry];
  });
  return {
    ...tracker,
    checkIns,
    occurrences: habitDays({ ...tracker, checkIns }, from, to, today),
    progress: empty ? null : tracker.progress,
  };
}
const client: NixClient = {
  ...createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }),
  query<T>(endpoint: QueryEndpoint<T>): Promise<T> {
    if (endpoint.operation === 'habits.read') {
      const id = endpoint.path.split('/')[4] ?? HABIT;
      return Promise.resolve(
        storyTracker(
          id,
          typeof endpoint.query?.from === 'string' ? endpoint.query.from : today,
          typeof endpoint.query?.to === 'string' ? endpoint.query.to : today,
        ) as T,
      );
    }
    throw new Error(`No habit story response for ${endpoint.operation}.`);
  },
  execute<T>(endpoint: CommandEndpoint<T>): Promise<T> {
    const parts = endpoint.path.split('/');
    const id = parts[4] ?? HABIT;
    const day = parts[7] ?? today;
    if (endpoint.operation === 'habits.checkIn') {
      const value = endpoint.body as { completed: boolean; quantity: number | null };
      const completed =
        value.quantity === null ? value.completed : value.quantity >= (id === WATER ? 8 : 1);
      editedCheckIns.set(`${id}:${day}`, { completed, quantity: value.quantity });
      return Promise.resolve({
        id: `${id}:${day}`,
        occurredOn: day,
        completed,
        quantity: value.quantity,
      } as T);
    }
    if (endpoint.operation === 'habits.undoCheckIn') {
      editedCheckIns.set(`${id}:${day}`, null);
      return Promise.resolve(null as T);
    }
    if (endpoint.operation === 'habits.status') {
      const body = endpoint.body as { status: 'active' | 'paused' | 'archived' };
      statuses.set(id, body.status);
      return Promise.resolve({ habitId: id, status: body.status } as T);
    }
    return Promise.reject(new Error('This action is unavailable in the preview.'));
  },
};
const workspace: Workspace = {
  id: WORKSPACE,
  name: 'Personal',
  versionRetentionDays: 90,
  storageQuotaBytes: 0,
  createdAt: '2026-01-01T00:00:00Z',
  kind: 'personal',
  canRename: true,
  canManageMembers: false,
  canLeave: false,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
  membershipLocked: false,
  collaboration: true,
};
const view: View = {
  id: 'habits',
  name: 'Habits',
  kind: 'habit_tracker',
  columns: [],
  filters: [],
  groupOrder: [],
  dateProperty: null,
  groupBy: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
  habitWidgets: [],
};
const children = [
  [HABIT, 'Walk outside'],
  [WATER, 'Drink water'],
  [PAUSED, 'Read before bed'],
].map(([id, title]) => ({
  id: id ?? '',
  title: title ?? '',
  workspaceId: WORKSPACE,
  parentId: 'daily',
  type: 'note',
  hasChildren: false,
  seq: 1,
  lifecycleState: 'active' as const,
  properties: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}));
const container: ContainerData = {
  itemId: 'daily',
  status: 'ready',
  error: null,
  refreshing: false,
  refreshError: null,
  locked: false,
  schema: null,
  views: { views: [view], unrenderable: [], default: view.id, hideDocument: false },
  children,
  writeError: null,
  truncated: false,
  create: saved,
  setProperties: saved,
  setPropertiesMany: () => Promise.resolve({ saved: 0, refused: [] }),
  setSchema: saved,
  setViews: saved,
  appendViewSetup: saved,
  replaceViewSetup: saved,
  setDefaultView: saved,
  setDocumentHidden: saved,
  reload: () => Promise.resolve(),
};
function Stage({ children: content }: { readonly children: ReactElement }): ReactElement {
  return <div className="@container mx-auto w-full max-w-4xl p-6">{content}</div>;
}
export default { title: 'Nix/Habits', parameters: { layout: 'padded' } };
export const Today = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={client}>
      <MemoryRouter initialEntries={[`/w/${WORKSPACE}`]}>
        <Routes>
          <Route
            path="/w/:workspaceId"
            element={
              <WorkspaceProvider
                state={{
                  status: 'ready',
                  workspaces: [workspace],
                  error: null,
                  reload: noop,
                  workspaceCreated: noop,
                  workspaceUpdated: noop,
                  workspaceRemoved: noop,
                }}
              >
                <Stage>
                  <ContainerView container={container} view={view} onOpen={noop} />
                </Stage>
              </WorkspaceProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>
  ),
};
/** Exercises the shared selection tray so the browser story's axe pass includes its controls. */
export const Selection = {
  ...Today,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select Walk outside' }));
    canvas.getByRole('toolbar', { name: 'Selected items' });
  },
};
/** The week grid on a phone: one-tap day cells. */
export const WeekPhone = {
  ...Today,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Show week' }));
  },
};
function InsightsStory({
  empty = false,
  year,
}: {
  readonly empty?: boolean;
  /** Holds back or refuses only the year grid's own read, so its loading and error states show. */
  readonly year?: 'loading' | 'error';
}): ReactElement {
  const habits = [
    { id: WATER, title: 'Drink water', tracker: storyTracker(WATER, undefined, undefined, empty) },
  ];
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <ApiClientOverrideProvider
      client={
        year !== undefined
          ? {
              ...client,
              query<T>(endpoint: QueryEndpoint<T>): Promise<T> {
                if (endpoint.query?.from === shiftHabitDay(today, -365)) {
                  return year === 'loading'
                    ? new Promise<T>(() => undefined)
                    : Promise.reject(new Error('The year could not be read.'));
                }
                return client.query(endpoint);
              },
            }
          : empty
            ? {
                ...client,
                query<T>(endpoint: QueryEndpoint<T>): Promise<T> {
                  return Promise.resolve(
                    storyTracker(
                      WATER,
                      typeof endpoint.query?.from === 'string' ? endpoint.query.from : today,
                      typeof endpoint.query?.to === 'string' ? endpoint.query.to : today,
                      true,
                    ) as T,
                  );
                },
              }
            : client
      }
    >
      <Stage>
        <HabitInsights
          habits={habits}
          renderDay={(_habit, day) => (
            <button
              type="button"
              onClick={() => {
                setSelected(day);
              }}
            >
              Example correction for {selected ?? day}
            </button>
          )}
        />
      </Stage>
    </ApiClientOverrideProvider>
  );
}
export const Insights = { render: (): ReactElement => <InsightsStory /> };
export const TodayPhone = { ...Today, parameters: { viewport: { defaultViewport: 'mobile1' } } };
export const InsightsPhone = {
  ...Insights,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const InsightsDark = { ...Insights, globals: { ground: 'dark' } };
export const InsightsYearLoading = { render: (): ReactElement => <InsightsStory year="loading" /> };
export const InsightsYearLoadingDark = { ...InsightsYearLoading, globals: { ground: 'dark' } };
export const InsightsYearError = { render: (): ReactElement => <InsightsStory year="error" /> };
export const InsightsYearErrorDark = { ...InsightsYearError, globals: { ground: 'dark' } };
export const NoRecordedAmounts = { render: (): ReactElement => <InsightsStory empty /> };
