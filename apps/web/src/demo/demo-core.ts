export const DEMO_WORKSPACE = '0199a000-0000-7000-8000-000000000001';
export const DEMO_PROFILE = {
  subject: 'demo-visitor',
  name: 'Ada Demo',
  email: 'ada@demo.invalid',
};

const CREATED = '2026-10-01T09:00:00+00:00';

type Json = Record<string, unknown>;

interface DemoItem {
  readonly id: string;
  parentId: string | null;
  readonly type: string;
  title: string;
  seq: number;
  properties: Json;
  updatedAt: string;
}

/** A date `offset` days from today, as the YYYY-MM-DD a date property stores. */
function day(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

let counter = 0x100;
function nextId(): string {
  counter += 1;
  return `0199a000-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export const PRODUCT_LAUNCH = nextId();
const PRIORITIES = nextId();
const LAUNCH_BRIEF = nextId();
const LANDING_PAGE = nextId();
const LAUNCH_VIDEO = nextId();

/** Note bodies the demo opens with, by item id; every other note starts empty. */
export const DEMO_NOTES: Readonly<Record<string, string>> = {
  [LAUNCH_BRIEF]: [
    '# Launch brief',
    '',
    'Northwind ships its new planner at the end of the month. This note holds the plan; the **Product launch** collection holds the work.',
    '',
    '## Goals',
    '',
    '- 500 beta sign-ups before launch day',
    '- A press kit ready a week ahead',
    '- No open high-priority tasks on the day',
    '',
    '## Timeline',
    '',
    '| Week | Focus | Owner |',
    '| --- | --- | --- |',
    '| 1 | Landing page and pricing | Ada |',
    '| 2 | Beta outreach and video | Sam |',
    '| 3 | Press kit and announcement | Ada |',
    '',
    '> Everything here is sample data held in this tab. Edit freely; a reload starts over.',
  ].join('\n'),
  [LANDING_PAGE]: [
    'Hero, three feature rows and a footer. Copy comes from **Website copy**.',
    '',
    '- [x] Wireframe',
    '- [ ] Final screenshots',
    '- [ ] Accessibility pass',
  ].join('\n'),
};
export const DEMO_ENTRY = `/w/${DEMO_WORKSPACE}?item=${PRODUCT_LAUNCH}`;

function sampleItems(): DemoItem[] {
  const item = (
    parentId: string | null,
    title: string,
    seq: number,
    properties: Json = {},
    id = nextId(),
  ): DemoItem => ({ id, parentId, type: 'note', title, seq, properties, updatedAt: CREATED });
  const task = (title: string, seq: number, values: Json): DemoItem =>
    item(PRODUCT_LAUNCH, title, seq, values);
  return [
    item(null, 'Product launch', 1, {}, PRODUCT_LAUNCH),
    item(null, 'Priorities', 2, {}, PRIORITIES),
    item(null, 'Launch brief', 3, {}, LAUNCH_BRIEF),
    task('Press kit', 1, { priority: 'Low', start: day(4), due: day(12), status: 'To do' }),
    task('Email announcement', 2, {
      priority: 'Medium',
      start: day(8),
      due: day(15),
      status: 'To do',
    }),
    task('Beta tester outreach', 3, {
      priority: 'High',
      start: day(2),
      due: day(9),
      status: 'To do',
    }),
    item(
      PRODUCT_LAUNCH,
      'Landing page design',
      4,
      { priority: 'High', start: day(-6), due: day(-1), status: 'In progress' },
      LANDING_PAGE,
    ),
    task('Pricing page', 5, {
      priority: 'Medium',
      start: day(-4),
      due: day(0),
      status: 'In progress',
    }),
    item(
      PRODUCT_LAUNCH,
      'Launch video',
      6,
      { priority: 'High', start: day(1), due: day(10), status: 'In progress' },
      LAUNCH_VIDEO,
    ),
    item(LAUNCH_VIDEO, 'Script', 1),
    item(LAUNCH_VIDEO, 'Shoot the walkthrough', 2),
    item(LAUNCH_VIDEO, 'Edit and caption', 3),
    task('Brand guidelines', 7, {
      priority: 'High',
      start: day(-13),
      due: day(-9),
      status: 'Done',
      done: true,
    }),
    task('Website copy', 8, {
      priority: 'Medium',
      start: day(-11),
      due: day(-6),
      status: 'Done',
      done: true,
    }),
    item(PRIORITIES, 'Fix the leaking tap', 1, { urgency: 'Urgent', importance: 'Important' }),
    item(PRIORITIES, 'Plan the garden', 2, { urgency: 'Not urgent', importance: 'Important' }),
    item(PRIORITIES, 'Reply to the group chat', 3, {
      urgency: 'Urgent',
      importance: 'Not important',
    }),
    item(PRIORITIES, 'Sort old photos', 4, {
      urgency: 'Not urgent',
      importance: 'Not important',
    }),
  ];
}

const select = (key: string, label: string, options: readonly string[]): Json => ({
  key,
  label,
  type: 'select',
  options,
  required: false,
});
const date = (key: string, label: string): Json => ({
  key,
  label,
  type: 'date',
  options: [],
  required: false,
});

/** A whole view as Core stores it: the given settings over every field left at its default. */
const view = (id: string, kind: string, settings: Json = {}): Json => ({
  id,
  name: id,
  kind,
  columns: [],
  groupBy: null,
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
  filters: [],
  ...settings,
});

/** What each container declares, and the views it offers; everything else has neither. */
const STRUCTURE: Record<string, { readonly properties: Json[]; readonly views: Json[] }> = {
  [PRODUCT_LAUNCH]: {
    properties: [
      select('priority', 'Priority', ['Low', 'Medium', 'High']),
      date('start', 'Start'),
      date('due', 'Due'),
      select('status', 'Status', ['To do', 'In progress', 'Done']),
      { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
    ],
    views: [
      view('board', 'board', { groupBy: 'status', columns: ['priority', 'due'] }),
      view('list', 'list', { columns: ['status', 'priority', 'due'] }),
      view('calendar', 'calendar', { dateProperty: 'due' }),
      view('timeline', 'timeline', { dateProperty: 'start', endDateProperty: 'due' }),
      view('sheet', 'sheet'),
      view('checklist', 'checklist', { columns: ['due'] }),
      view('gallery', 'gallery', { columns: ['status', 'priority'] }),
      view('chart', 'chart', { groupBy: 'status', chart: { kind: 'column' } }),
      view('outline', 'outline'),
      view('form', 'form', { columns: ['priority', 'due', 'status'] }),
    ],
  },
  [PRIORITIES]: {
    properties: [
      select('urgency', 'Urgency', ['Urgent', 'Not urgent']),
      select('importance', 'Importance', ['Important', 'Not important']),
    ],
    views: [
      view('matrix', 'matrix', { groupBy: 'urgency', rowBy: 'importance' }),
      view('list', 'list', { columns: ['urgency', 'importance'] }),
    ],
  },
};

const WORKSPACE: Json = {
  id: DEMO_WORKSPACE,
  name: 'Northwind Studio',
  versionRetentionDays: 90,
  storageQuotaBytes: 0,
  createdAt: CREATED,
  kind: 'personal',
  canRename: false,
  canManageMembers: false,
  canLeave: false,
  canUseDailyNotes: false,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
};

interface DemoRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

type Handler = (request: DemoRequest, match: RegExpMatchArray) => Response | null;

/**
 * Core for the server-free demo: answers the API client's requests from a sample workspace held
 * in memory, so the real application renders without a server. Handed to the client as its
 * `fetch`; nothing here ever reaches the network, and a reload starts over.
 */
export function createDemoFetch(): typeof fetch {
  const items = new Map(sampleItems().map((entry) => [entry.id, entry]));
  const trashed = new Set<string>();
  const structure = new Map(
    Object.entries(STRUCTURE).map(([id, { properties, views }]) => [
      id,
      {
        properties: [...properties],
        views: [...views],
        default: typeof views[0]?.id === 'string' ? views[0].id : '',
      },
    ]),
  );
  const now = (): string => new Date().toISOString();

  const live = (): DemoItem[] => [...items.values()].filter((entry) => !trashed.has(entry.id));
  const toItem = (entry: DemoItem): Json => ({
    id: entry.id,
    workspaceId: DEMO_WORKSPACE,
    parentId: entry.parentId,
    type: entry.type,
    title: entry.title,
    hasChildren: live().some((child) => child.parentId === entry.id),
    seq: entry.seq,
    lifecycleState: trashed.has(entry.id) ? 'deleted' : 'active',
    properties: entry.properties,
    createdAt: CREATED,
    updatedAt: entry.updatedAt,
  });
  const siblingsOf = (parentId: string | null): DemoItem[] =>
    live()
      .filter((entry) => entry.parentId === parentId)
      .sort((a, b) => a.seq - b.seq);
  const itemAt = (id: string | undefined): DemoItem | undefined =>
    id === undefined ? undefined : items.get(id);
  const structureOf = (id: string | undefined) =>
    (id === undefined ? undefined : structure.get(id)) ?? {
      properties: [] as Json[],
      views: [] as Json[],
      default: '',
    };
  const viewsOf = (id: string | undefined): Json => {
    const { views, default: defaultView } = structureOf(id);
    return {
      views,
      unrenderable: [],
      default: views.length === 0 ? 'document' : defaultView,
      hideDocument: views.length > 0,
      version: '1',
    };
  };
  const field = (body: unknown, key: string): unknown =>
    typeof body === 'object' && body !== null ? (body as Json)[key] : undefined;
  const text = (body: unknown, key: string, fallback: string): string => {
    const value = field(body, key);
    return typeof value === 'string' ? value : fallback;
  };
  /** Properties as Core stores them: a field with no choices keeps an empty list, never null. */
  const propertiesIn = (value: unknown): Json[] | undefined =>
    Array.isArray(value)
      ? (value as Json[]).map((property) => ({
          ...property,
          options: Array.isArray(property.options) ? property.options : [],
        }))
      : undefined;
  /** Changes one stored item and answers with it, or falls through to "not offered". */
  const change = (id: string | undefined, apply: (entry: DemoItem) => void): Response | null => {
    const entry = itemAt(id);
    if (entry === undefined) return null;
    apply(entry);
    entry.updatedAt = now();
    return json(toItem(entry));
  };
  const subtree = (id: string): string[] => [
    id,
    ...live()
      .filter((entry) => entry.parentId === id)
      .flatMap((entry) => subtree(entry.id)),
  ];

  const routes: [string, RegExp, Handler][] = [
    [
      'GET',
      /^\/api\/v1\/me$/,
      () =>
        json({
          id: '0199a000-0000-7000-8000-0000000000aa',
          tenantId: '0199a000-0000-7000-8000-0000000000bb',
          displayName: DEMO_PROFILE.name,
          email: DEMO_PROFILE.email,
          isTenantAdministrator: false,
          features: { sites: false, mcpUrl: null, operator: false, siteApprover: false },
        }),
    ],
    ['GET', /^\/api\/v1\/me\/bookmarks$/, () => json({ items: [], hidden: 0 })],
    [
      'GET',
      /^\/api\/v1\/me\/preferences$/,
      () =>
        json({
          revision: 0,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          quietStart: null,
          quietEnd: null,
          dueReminderTime: '09:00',
          dueReminders: false,
          habitReminders: false,
          mutedContainerIds: [],
        }),
    ],
    ['POST', /^\/api\/v1\/search\/mentions$/, () => json({ mentions: [], truncated: false })],
    [
      'GET',
      /^\/api\/v1\/me\/ui-settings$/,
      () => json({ settings: { 'editor.viewSuggestions': 'off' }, revision: 0 }),
    ],
    [
      'GET',
      /^\/api\/v1\/me\/notifications(\/watch)?$/,
      () => json({ items: [], nextCursor: null, unread: 0, revision: 0 }),
    ],
    [
      'GET',
      /^\/api\/v1\/me\/pets\/settings$/,
      () =>
        json({
          revision: 0,
          settings: { enabled: false, activePetId: null, motion: 'system', profiles: [] },
        }),
    ],
    [
      'GET',
      /^\/api\/v1\/me\/workspace-arrangement$/,
      () => json({ revision: 0, groups: [], pinnedWorkspaceIds: [] }),
    ],
    ['GET', /^\/api\/v1\/workspaces$/, () => json(page([WORKSPACE]))],
    ['GET', /^\/api\/v1\/workspaces\/[^/]+$/, () => json(WORKSPACE)],
    [
      'GET',
      /^\/api\/v1\/workspaces\/[^/]+\/templates$/,
      () => json({ templates: [], capabilities: { canManage: false } }),
    ],
    ['GET', /^\/api\/v1\/workspaces\/[^/]+\/automations$/, () => json({ items: [] })],
    [
      'GET',
      /^\/api\/v1\/workspaces\/[^/]+\/daily-notes\/settings$/,
      () =>
        json({
          enabled: false,
          folders: 'flat',
          titleFormat: 'iso',
          template: '',
          rolloverHour: 0,
          showOnCalendar: false,
        }),
    ],
    [
      'GET',
      /^\/api\/v1\/workspaces\/[^/]+\/calendar$/,
      ({ query }) =>
        json({
          workspaceId: DEMO_WORKSPACE,
          from: query.get('from') ?? '',
          to: query.get('to') ?? '',
          entries: live()
            .filter((entry) => typeof entry.properties.due === 'string')
            .map((entry) => ({
              itemId: entry.id,
              title: entry.title,
              containerId: entry.parentId,
              containerTitle: itemAt(entry.parentId ?? undefined)?.title ?? null,
              dateProperty: 'due',
              value: entry.properties.due,
              kind: 'date',
              generated: false,
              completed: entry.properties.done === true,
            })),
          unplaceable: [],
          entryLimit: 1000,
          entriesTruncated: false,
          seriesTruncated: false,
        }),
    ],
    [
      'GET',
      /^\/api\/v1\/workspaces\/[^/]+\/graph$/,
      () =>
        json({
          workspaceId: DEMO_WORKSPACE,
          nodes: live().map((entry) => ({
            id: entry.id,
            parentId: entry.parentId,
            type: entry.type,
            title: entry.title,
            createdAt: CREATED,
            lastModifiedAt: entry.updatedAt,
          })),
          links: [],
          nodeLimit: 1000,
          linkLimit: 1000,
          nodesTruncated: false,
          linksTruncated: false,
        }),
    ],
    [
      'GET',
      /^\/api\/v1\/workspaces\/[^/]+\/items\/trash$/,
      () =>
        json(
          page(
            [...trashed].flatMap((id) => {
              const entry = items.get(id);
              return entry === undefined ? [] : [toItem(entry)];
            }),
          ),
        ),
    ],
    [
      'GET',
      /^\/api\/v1\/workspaces\/[^/]+\/items$/,
      ({ query }) => json(page(siblingsOf(query.get('parentId')).map(toItem))),
    ],
    [
      'POST',
      /^\/api\/v1\/workspaces\/[^/]+\/items$/,
      ({ body }) => {
        const parentId = (field(body, 'parentId') as string | null | undefined) ?? null;
        const entry: DemoItem = {
          id: nextId(),
          parentId,
          type: text(body, 'type', 'note'),
          title: text(body, 'title', 'Untitled'),
          seq: Math.max(0, ...siblingsOf(parentId).map((sibling) => sibling.seq)) + 1,
          properties: (field(body, 'properties') as Json | null | undefined) ?? {},
          updatedAt: now(),
        };
        items.set(entry.id, entry);
        return json(toItem(entry), 201);
      },
    ],
    [
      'POST',
      /^\/api\/v1\/workspaces\/[^/]+\/structured-items$/,
      ({ body }) => {
        const parentId = (field(body, 'parentId') as string | null | undefined) ?? null;
        const entry: DemoItem = {
          id: nextId(),
          parentId,
          type: text(body, 'type', 'note'),
          title: text(body, 'title', 'Untitled'),
          seq: Math.max(0, ...siblingsOf(parentId).map((sibling) => sibling.seq)) + 1,
          properties: {},
          updatedAt: now(),
        };
        items.set(entry.id, entry);
        const views = (field(field(body, 'views'), 'views') as Json[] | undefined) ?? [];
        structure.set(entry.id, {
          properties: propertiesIn(field(field(body, 'schema'), 'properties')) ?? [],
          views,
          default: text(
            field(body, 'views'),
            'default',
            typeof views[0]?.id === 'string' ? views[0].id : '',
          ),
        });
        return json({ item: toItem(entry), publicForm: null }, 201);
      },
    ],
    [
      'POST',
      /^\/api\/v1\/items\/([^/]+)\/view-setups$/,
      ({ body }, [, id]) => {
        const entry = itemAt(id);
        if (entry === undefined) return null;
        const current = structureOf(entry.id);
        const added = propertiesIn(field(body, 'properties')) ?? [];
        const views = (field(body, 'views') as Json[] | undefined) ?? [];
        structure.set(entry.id, {
          properties: [
            ...current.properties.filter(
              (property) => !added.some((next) => next.key === property.key),
            ),
            ...added,
          ],
          views: [...current.views, ...views],
          default:
            field(body, 'makeDefault') === true && typeof views[0]?.id === 'string'
              ? views[0].id
              : current.default || (typeof views[0]?.id === 'string' ? views[0].id : ''),
        });
        return json({ item: toItem(entry), publicForm: null });
      },
    ],
    [
      'PUT',
      /^\/api\/v1\/items\/([^/]+)\/view-setups\/([^/]+)$/,
      ({ body }, [, id, viewId]) => {
        const entry = itemAt(id);
        if (entry === undefined || viewId === undefined) return null;
        const current = structureOf(entry.id);
        const original = decodeURIComponent(viewId);
        const views = (field(body, 'views') as Json[] | undefined) ?? [];
        const at = current.views.findIndex((existing) => existing.id === original);
        const kept = current.views.filter((existing) => existing.id !== original);
        kept.splice(at < 0 ? kept.length : at, 0, ...views);
        structure.set(entry.id, {
          properties:
            propertiesIn(field(field(body, 'schema'), 'properties')) ?? current.properties,
          views: kept,
          default:
            current.default === original && typeof views[0]?.id === 'string'
              ? views[0].id
              : current.default,
        });
        return json({ item: toItem(entry), publicForm: null });
      },
    ],
    [
      'GET',
      /^\/api\/v1\/items\/([^/]+)$/,
      (_, [, id]) => {
        const entry = itemAt(id);
        return entry === undefined ? null : json(toItem(entry));
      },
    ],
    [
      'PATCH',
      /^\/api\/v1\/items\/([^/]+)$/,
      ({ body }, [, id]) =>
        change(id, (entry) => {
          entry.title = text(body, 'title', entry.title);
        }),
    ],
    [
      'PATCH',
      /^\/api\/v1\/items\/([^/]+)\/properties$/,
      ({ body }, [, id]) =>
        change(id, (entry) => {
          entry.properties = { ...entry.properties, ...(field(body, 'properties') as Json) };
        }),
    ],
    [
      'POST',
      /^\/api\/v1\/items\/([^/]+)\/move$/,
      ({ body }, [, id]) =>
        change(id, (entry) => {
          const parentId = (field(body, 'parentId') as string | null | undefined) ?? null;
          const afterId = field(body, 'afterId') as string | null | undefined;
          const order = siblingsOf(parentId).filter((sibling) => sibling.id !== entry.id);
          const at = afterId == null ? 0 : order.findIndex((sibling) => sibling.id === afterId) + 1;
          order.splice(at, 0, entry);
          entry.parentId = parentId;
          order.forEach((sibling, index) => (sibling.seq = index + 1));
        }),
    ],
    [
      'DELETE',
      /^\/api\/v1\/items\/([^/]+)$/,
      (_, [, id]) => {
        if (itemAt(id) === undefined || id === undefined) return null;
        for (const gone of subtree(id)) trashed.add(gone);
        return new Response(null, { status: 204 });
      },
    ],
    [
      'POST',
      /^\/api\/v1\/items\/([^/]+)\/restore$/,
      (_, [, id]) =>
        change(id, (entry) => {
          trashed.delete(entry.id);
        }),
    ],
    [
      'GET',
      /^\/api\/v1\/items\/([^/]+)\/chart$/,
      ({ query }, [, id]) => {
        const chartView = structureOf(id).views.find((entry) => entry.id === query.get('view'));
        if (id === undefined || chartView === undefined) return null;
        const groupBy = typeof chartView.groupBy === 'string' ? chartView.groupBy : '';
        const measure = typeof chartView.measure === 'string' ? chartView.measure : 'count';
        const measureProperty =
          typeof chartView.measureProperty === 'string' ? chartView.measureProperty : null;
        const children = siblingsOf(id);
        const buckets = new Map<string | null, { children: number; total: number }>();
        for (const child of children) {
          const raw = child.properties[groupBy];
          const key = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null;
          const bucket = buckets.get(key) ?? { children: 0, total: 0 };
          bucket.children += 1;
          const amount = measureProperty === null ? 0 : Number(child.properties[measureProperty]);
          if (Number.isFinite(amount)) bucket.total += amount;
          buckets.set(key, bucket);
        }
        return json({
          itemId: id,
          viewId: query.get('view'),
          groupBy,
          measure,
          measureProperty,
          buckets: [...buckets].map(([value, bucket]) => ({
            value,
            children: bucket.children,
            total: measure === 'sum' ? bucket.total : null,
          })),
          children: children.length,
          distinctValues: buckets.size,
          truncated: false,
        });
      },
    ],
    [
      'GET',
      /^\/api\/v1\/items\/([^/]+)\/query$/,
      ({ query }, [, id]) =>
        json({
          itemId: id,
          viewId: query.get('view') ?? '',
          today: query.get('today') ?? day(0),
          // shortcut: returns every item without applying the view's filters, until the demo grows a filter engine.
          results: live()
            .filter((entry) => entry.parentId !== null && entry.parentId !== id)
            .map((entry) => ({
              id: entry.id,
              workspaceId: DEMO_WORKSPACE,
              containerId: entry.parentId,
              containerTitle: itemAt(entry.parentId ?? undefined)?.title ?? null,
              title: entry.title,
              type: entry.type,
              properties: entry.properties,
            })),
          limit: 500,
          truncated: false,
        }),
    ],
    ['GET', /^\/api\/v1\/me\/canvas-library$/, () => json({ items: [] })],
    [
      'PUT',
      /^\/api\/v1\/me\/canvas-library$/,
      ({ body }) => json({ items: field(body, 'items') ?? [] }),
    ],
    [
      'GET',
      /^\/api\/v1\/items\/[^/]+\/lock$/,
      () => json({ locked: false, unlockedUntil: null, lockItemId: null, selfLocked: false }),
    ],
    [
      'GET',
      /^\/api\/v1\/items\/([^/]+)\/schema$/,
      (_, [, id]) => {
        const { properties } = structureOf(id);
        return json({ properties, declared: properties, inherit: true });
      },
    ],
    [
      'PUT',
      /^\/api\/v1\/items\/([^/]+)\/schema$/,
      ({ body }, [, id]) => {
        if (id === undefined) return null;
        const current = structureOf(id);
        const properties = propertiesIn(field(body, 'properties')) ?? [];
        structure.set(id, { ...current, properties });
        return json({ properties, declared: properties, inherit: true });
      },
    ],
    ['GET', /^\/api\/v1\/items\/([^/]+)\/views$/, (_, [, id]) => json(viewsOf(id))],
    [
      'PUT',
      /^\/api\/v1\/items\/([^/]+)\/views$/,
      ({ body }, [, id]) => {
        if (id === undefined) return null;
        const current = structureOf(id);
        structure.set(id, {
          ...current,
          views: (field(body, 'views') as Json[] | undefined) ?? current.views,
          default: text(body, 'default', current.default),
        });
        return json(viewsOf(id));
      },
    ],
  ];

  return (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'https://demo.invalid',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: unknown =
      typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : null;
    const request: DemoRequest = { method, path: url.pathname, query: url.searchParams, body };
    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue;
      const match = url.pathname.match(pattern);
      if (match === null) continue;
      const response = handler(request, match);
      if (response !== null) return Promise.resolve(response);
    }
    console.warn('[demo] unhandled', method, url.pathname + url.search);
    return Promise.resolve(problem(501, 'demo.unsupported', 'Not in the demo'));
  };
}

function page(entries: readonly unknown[]): Json {
  return { items: entries, nextCursor: null };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, code: string, title: string): Response {
  const detail = "The demo doesn't include this. It needs a Nix server.";
  return new Response(JSON.stringify({ type: 'about:blank', title, status, code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}
