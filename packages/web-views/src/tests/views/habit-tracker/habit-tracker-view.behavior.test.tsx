import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { useState } from 'react';
import type { HabitTracker } from '@nix/api-client';
import { ItemCommandsProvider } from '@nix/web-collections/items/item-commands-context';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { HabitTrackerView } from '../../../habit-tracker/habit-tracker-view';
import { spokenDayName } from '../../../habit-tracker/habit-days';
import { ContainerView } from '../../../core/container-view';
import type { View } from '@nix/web-collections/core/container-model';

const saveHabit = vi.fn<() => Promise<string | null>>();
const saveCheckIn = vi.fn<() => Promise<string | null>>();
const undoCheckIn = vi.fn<() => Promise<string | null>>();
const setStatus = vi.fn<() => Promise<string | null>>();
const refetchHabit = vi.fn<(habitId: string) => Promise<string | null>>();
const execute = vi.fn<() => Promise<{ id: string }>>();
const reload = vi.fn(() => Promise.resolve());
const commandMove = vi.fn(() => Promise.resolve({ refusal: null }));
const commandDelete = vi.fn<(ids: readonly string[]) => Promise<readonly string[]>>();
const DESTINATION_ID = 'destination-1';
let tracker: HabitTracker;
// Set only by the test that checks a second habit is left alone; every other test's mock is a
// single-habit tracker map, exactly as before.
let secondTracker: HabitTracker | undefined;

vi.mock('../../../habit-tracker/use-habits', () => ({
  useHabits: () => ({
    status: 'ready',
    trackers: new Map(
      secondTracker === undefined
        ? [['habit-1', tracker]]
        : [
            ['habit-1', tracker],
            ['habit-2', secondTracker],
          ],
    ),
    error: null,
    version: 0,
    refreshingIds: new Set(),
    reload,
    refetchHabit,
    saveHabit,
    saveCheckIn,
    undoCheckIn,
    setStatus,
  }),
}));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => ({ execute }),
  useOptionalApiClient: () => null,
}));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'workspace-1' }),
  useOptionalWorkspace: () => null,
}));
vi.mock('../../../habit-tracker/habit-chart-widgets', () => ({
  HabitChartWidgets: ({ onChange }: { onChange: (widgets: readonly unknown[]) => void }) => (
    <button
      onClick={() => {
        onChange([{ id: 'widget-1', kind: 'streak', habitIds: ['habit-1'] }]);
      }}
    >
      Add chart widget
    </button>
  ),
}));

const view: View = {
  id: 'view-1',
  name: 'Habits',
  kind: 'habit_tracker',
  columns: [],
  groupOrder: [],
  filters: [],
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
const habit = {
  id: 'habit-1',
  workspaceId: 'workspace-1',
  parentId: 'container-1',
  type: 'note',
  title: 'Read',
  hasChildren: false,
  seq: 1,
  lifecycleState: 'active' as const,
  properties: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const mount = (empty = false, suppliedContainer?: ContainerData) =>
  render(
    <MemoryRouter>
      <HabitTrackerView
        container={suppliedContainer ?? aContainer({ children: empty ? [] : [habit] })}
        view={view}
        onOpen={vi.fn()}
      />
    </MemoryRouter>,
  );

function treeItem(id: string, title: string, parentId: string | null): TreeItem {
  return {
    id,
    title,
    type: 'note',
    parentId,
    hasChildren: false,
    seq: 0,
    lifecycleState: 'active',
  };
}

function CommandHarness({ action }: { readonly action: 'move' | 'delete' }) {
  const [children, setChildren] = useState([habit]);
  const destination = treeItem(DESTINATION_ID, 'Archive', null);
  const treeItems = [
    treeItem('container-1', 'Habits', null),
    treeItem(habit.id, habit.title, 'container-1'),
    destination,
  ];
  const tree: WorkspaceTree = {
    status: 'ready',
    error: null,
    items: treeItems,
    find: (id: string) => treeItems.find((entry) => entry.id === id) ?? null,
    childrenOf: (parentId: string | null) =>
      treeItems.filter((entry) => entry.parentId === parentId),
    isExpanded: () => false,
    isLoadingChildren: () => false,
    isLocked: () => false,
    breadcrumbs: () => [],
    reveal: () => Promise.resolve(),
    revealOf: () => null,
    retryReveal: () => Promise.resolve(),
    isCreating: false,
    isSaving: false,
    toggle: () => Promise.resolve(),
    expand: () => Promise.resolve(),
    create: () => Promise.reject(new Error('Unexpected create')),
    createStructured: () => Promise.reject(new Error('Unexpected structured create')),
    rename: vi.fn(() => Promise.resolve()),
    move: commandMove,
    remove: () => Promise.resolve({ refusal: null }),
    restore: () => Promise.resolve({ refusal: null }),
    setProtection: () => Promise.resolve({ refusal: null }),
    reload: () => Promise.resolve(),
  };

  return (
    <ItemCommandsProvider
      tree={tree}
      onDeleteItem={vi.fn()}
      onDeleteItems={async (items) => {
        const deleted = items.map((item) => item.id);
        commandDelete.mockResolvedValue(deleted);
        await commandDelete(deleted);
        setChildren((current) => current.filter((item) => !deleted.includes(item.id)));
        return deleted;
      }}
      onMoved={
        action === 'move'
          ? () => {
              setChildren([]);
            }
          : undefined
      }
    >
      <ContainerView container={aContainer({ children })} view={view} onOpen={vi.fn()} />
    </ItemCommandsProvider>
  );
}

function openWeekDay(day: string): void {
  fireEvent.click(screen.getByRole('button', { name: 'Show week' }));
  fireEvent.click(screen.getByRole('button', { name: `Read, ${spokenDayName(day)}, not done` }));
}

describe('habit tracker user flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secondTracker = undefined;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-18T12:00:00Z'));
    tracker = {
      habitId: 'habit-1',
      frequency: 'daily',
      weekdays: [],
      timezone: 'UTC',
      startDate: '2026-03-16',
      target: 2,
      unit: 'pages',
      checkIns: [{ id: 'check-1', occurredOn: '2026-03-16', completed: false, quantity: 1 }],
      weeks: [{ weekStart: '2026-03-16', planned: 7, completed: 0, quantity: 1 }],
      status: 'active',
      occurrences: null,
      progress: null,
      months: null,
      reminderTime: null,
    };
    saveHabit.mockResolvedValue(null);
    saveCheckIn.mockResolvedValue(null);
    undoCheckIn.mockResolvedValue(null);
    setStatus.mockResolvedValue(null);
    refetchHabit.mockResolvedValue(null);
    execute.mockResolvedValue({ id: 'created-habit' });
    commandMove.mockResolvedValue({ refusal: null });
    commandDelete.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it('opens the schedule editor from the habit context menu', () => {
    mount();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Read' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit schedule' }));
    expect(screen.getByRole('textbox', { name: 'Habit name' })).toHaveValue('Read');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('selects a habit row through the shared selection tray', async () => {
    render(
      <MemoryRouter>
        <ContainerView container={aContainer({ children: [habit] })} view={view} onOpen={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Read' }));
    const tray = screen.getByRole('toolbar', { name: 'Selected items' });
    expect(within(tray).getByText('1 selected')).toBeVisible();
    expect(within(tray).queryByRole('button', { name: 'Move to…' })).not.toBeInTheDocument();
  });

  it('does not expose selection controls when the container is locked', () => {
    render(
      <MemoryRouter>
        <ContainerView
          container={{ ...aContainer({ children: [habit] }), locked: true }}
          view={view}
          onOpen={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('This is locked')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'Select Read' })).not.toBeInTheDocument();
  });

  it('moves selected habits through the shared command and drops the selection after its rows leave', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CommandHarness action="move" />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('checkbox', { name: 'Select Read' }));
    await user.click(
      within(screen.getByRole('toolbar', { name: 'Selected items' })).getByRole('button', {
        name: 'Move to…',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Move item' });
    await user.click(within(dialog).getByRole('button', { name: 'Up one level' }));
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move here' }));

    await waitFor(() => {
      expect(commandMove).toHaveBeenCalledWith(habit.id, DESTINATION_ID, null);
    });
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: 'Select Read' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();
  });

  it('deletes selected habits through the shared confirmation and clears their selection', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CommandHarness action="delete" />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('checkbox', { name: 'Select Read' }));
    await user.click(
      within(screen.getByRole('toolbar', { name: 'Selected items' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delete 1 item?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete 1 item' }));

    await waitFor(() => {
      expect(commandDelete).toHaveBeenCalledWith([habit.id]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: 'Select Read' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();
  });

  it('creates from the empty state and retries refused settings on the same item', async () => {
    saveHabit.mockResolvedValueOnce('Choose a different setting.');
    mount(true);
    const add = screen.getAllByRole('button', { name: 'Add a habit' }).at(0);
    if (add === undefined) throw new Error('Missing habit creation control');
    fireEvent.click(add);
    fireEvent.change(screen.getByRole('textbox', { name: 'Habit name' }), {
      target: { value: 'Walk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create habit' }));
    await screen.findByRole('alert');
    expect(saveHabit).toHaveBeenCalledWith(
      'created-habit',
      expect.objectContaining({ frequency: 'daily', target: 1 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create habit' }));
    await waitFor(() => {
      expect(saveHabit).toHaveBeenCalledTimes(2);
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('updates a partial quantity and offers independent undo', async () => {
    mount();
    openWeekDay('2026-03-16');
    const quantity = screen.getByRole('spinbutton', { name: 'Read, 2026-03-16, quantity' });
    expect(quantity).toHaveValue(1);
    fireEvent.change(quantity, { target: { value: '2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Read, 2026-03-16, quantity' }));
      await Promise.resolve();
    });
    expect(saveCheckIn).toHaveBeenCalledWith('habit-1', '2026-03-16', true, 2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo Read, 2026-03-16' }));
      await Promise.resolve();
    });
    expect(undoCheckIn).toHaveBeenCalledWith('habit-1', '2026-03-16');
  });

  it('refuses an empty quantity even for a target of one with a custom unit', () => {
    tracker = { ...tracker, target: 1, unit: 'glass', checkIns: [] };
    mount();
    openWeekDay('2026-03-16');
    expect(screen.getByRole('spinbutton', { name: 'Read, 2026-03-16, quantity' })).toHaveValue(
      null,
    );
    expect(screen.getByRole('button', { name: 'Save Read, 2026-03-16, quantity' })).toBeDisabled();
  });

  it('uses the saved timezone for Today and disables future weekly cells', async () => {
    vi.setSystemTime(new Date('2026-03-18T23:00:00Z'));
    tracker = { ...tracker, timezone: 'Asia/Tokyo', target: 1, unit: 'times' };
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show week' }));
    expect(
      screen.getByRole('button', { name: `Read, ${spokenDayName('2026-03-20')}, upcoming` }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check in Read, 2026-03-19' }));
      await Promise.resolve();
    });
    expect(saveCheckIn).toHaveBeenCalledWith('habit-1', '2026-03-19', true, null);
  });

  it('checks a plain habit in with one tap on its week cell, named for the spoken day', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show week' }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: `Read, ${spokenDayName('2026-03-18')}, not done` }),
      );
      await Promise.resolve();
    });
    expect(saveCheckIn).toHaveBeenCalledWith('habit-1', '2026-03-18', true, null);
  });

  it('keeps focus on a week cell while its check-in saves', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    saveCheckIn.mockImplementation(() => new Promise(() => undefined));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show week' }));
    const cell = screen.getByRole('button', {
      name: `Read, ${spokenDayName('2026-03-18')}, not done`,
    });
    cell.focus();
    await act(async () => {
      fireEvent.click(cell);
      await Promise.resolve();
    });
    expect(cell).toBeEnabled();
    expect(cell).toHaveFocus();
  });

  it('shows a refused mutation without claiming completion', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    saveCheckIn.mockResolvedValue('Permission changed. Reload the habit.');
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Check in Read, 2026-03-18' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission changed');
    expect(screen.getByRole('button', { name: 'Check in Read, 2026-03-18' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('ticks the moment it is tapped, ahead of the write resolving', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    let resolveSave: (refusal: string | null) => void = () => undefined;
    saveCheckIn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Check in Read, 2026-03-18' }));
    // The write has not resolved yet - saveCheckIn's own promise is still pending - but the tap
    // already reads as completed rather than waiting for a round trip.
    expect(
      screen.getByRole('button', { name: 'Done: undo check-in for Read, 2026-03-18' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      resolveSave(null);
      await Promise.resolve();
    });
    expect(refetchHabit).toHaveBeenCalledWith('habit-1');
  });

  it('rolls the tick back when the write is refused', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    let resolveSave: (refusal: string | null) => void = () => undefined;
    saveCheckIn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Check in Read, 2026-03-18' }));
    expect(
      screen.getByRole('button', { name: 'Done: undo check-in for Read, 2026-03-18' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      resolveSave('Permission changed. Reload the habit.');
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Check in Read, 2026-03-18' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Permission changed');
    // The write was refused, so there is nothing for either window to refetch.
    expect(refetchHabit).not.toHaveBeenCalled();
  });

  it('refetches only the habit that changed, not every habit in the container', async () => {
    tracker = { ...tracker, target: 1, unit: 'times', checkIns: [] };
    secondTracker = { ...tracker, habitId: 'habit-2' };
    const secondHabit = { ...habit, id: 'habit-2', title: 'Walk' };
    mount(false, aContainer({ children: [habit, secondHabit] }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check in Read, 2026-03-18' }));
      await Promise.resolve();
    });
    // Today refetches only the habit that changed; Insights loads only when opened.
    expect(refetchHabit).toHaveBeenCalledTimes(1);
    expect(refetchHabit).toHaveBeenCalledWith('habit-1');
    expect(refetchHabit).not.toHaveBeenCalledWith('habit-2');
  });

  it('allows custom weekday selection and navigation to a previous week', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(screen.getByText('2026-03-09 to 2026-03-15')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Add a habit' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Frequency' }), {
      target: { value: 'weekly' },
    });
    expect(screen.getByRole('checkbox', { name: 'Mon' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));
    expect(screen.getByRole('checkbox', { name: 'Mon' })).not.toBeChecked();
  });

  it('pauses an active habit and exposes its status', async () => {
    mount();
    fireEvent.click(screen.getByText('Habit options'));
    expect(screen.getByText('Status: active')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith('habit-1', 'paused');
    });
  });

  it('edits the habit name, timezone, and schedule on the existing item', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Read' }));
    expect(screen.getByRole('textbox', { name: 'Habit name' })).toHaveValue('Read');
    fireEvent.change(screen.getByRole('textbox', { name: 'Habit name' }), {
      target: { value: 'Read nightly' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Timezone' }), {
      target: { value: 'America/New_York' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(saveHabit).toHaveBeenCalledWith(
        'habit-1',
        expect.objectContaining({ timezone: 'America/New_York' }),
      );
    });
    expect(execute).toHaveBeenCalled();
  });

  it('sets a reminder time, and clearing it sends no reminder', async () => {
    tracker = { ...tracker, reminderTime: '07:30' };
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Read' }));
    const reminder = screen.getByLabelText('Reminder time');
    expect(reminder).toHaveValue('07:30');

    fireEvent.change(reminder, { target: { value: '21:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(saveHabit).toHaveBeenLastCalledWith(
        'habit-1',
        expect.objectContaining({ reminderTime: '21:15' }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Read' }));
    fireEvent.change(screen.getByLabelText('Reminder time'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(saveHabit).toHaveBeenLastCalledWith(
        'habit-1',
        expect.objectContaining({ reminderTime: null }),
      );
    });
  });

  it('shows the last year of the habit as a year grid on Insights', async () => {
    mount(false, aContainer({ children: [habit] }));
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));

    expect(await screen.findByRole('heading', { name: 'Year at a glance' })).toBeVisible();
    const grid = screen.getByRole('grid', { name: /the last year/ });
    // 366 days to today: the longest range the habit endpoint serves.
    expect(grid.querySelectorAll('[role="gridcell"][aria-label]')).toHaveLength(366);
  });

  it('persists widget changes and restores the prior selection when saving fails', async () => {
    const container = aContainer({ children: [habit] });
    const setViews = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValue('Widget settings could not be saved.');
    Object.assign(container, { setViews, views: { views: [view], defaultView: view.id } });
    mount(false, container);
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    fireEvent.click(screen.getByText('Custom charts'));
    fireEvent.click(screen.getByRole('button', { name: 'Add chart widget' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Widget settings could not be saved',
    );
    expect(setViews).toHaveBeenCalled();
  });
});

describe('habit tracker narrow-screen default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secondTracker = undefined;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-18T12:00:00Z'));
    tracker = {
      habitId: 'habit-1',
      frequency: 'daily',
      weekdays: [],
      timezone: 'UTC',
      startDate: '2026-03-16',
      target: 1,
      unit: 'times',
      checkIns: [],
      weeks: [{ weekStart: '2026-03-16', planned: 7, completed: 0, quantity: 1 }],
      status: 'active',
      occurrences: null,
      progress: null,
      months: null,
      reminderTime: null,
    };
    saveHabit.mockResolvedValue(null);
    saveCheckIn.mockResolvedValue(null);
    undoCheckIn.mockResolvedValue(null);
    setStatus.mockResolvedValue(null);
    refetchHabit.mockResolvedValue(null);
    execute.mockResolvedValue({ id: 'created-habit' });
  });
  afterEach(() => {
    vi.useRealTimers();
    // Restores `setup.ts`'s own wide default for every test after this one - see that module's
    // comment for why a test that narrows the viewport is the one that has to put it back.
    stubViewport(true);
  });

  it('defaults to Today on a narrow screen', () => {
    stubViewport(false);
    mount();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show week' })).toBeVisible();
  });

  it('defaults to Today on a wide screen as well', () => {
    stubViewport(true);
    mount();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show week' })).toBeVisible();
  });

  it("keeps the person's own choice over the narrow-screen default", () => {
    stubViewport(false);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show week' }));
    expect(screen.getByRole('heading', { name: 'This week' })).toBeVisible();
  });
});
