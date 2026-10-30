// The AI companion for the server-free demo: one pet, a conversation that already happened, and
// scripted replies. No model is involved, so the same message always gets the same answer.
type Json = Record<string, unknown>;

export interface DemoAiEnv {
  readonly workspaceId: string;
  /** Ids of the sample items the seeded conversation talks about. */
  readonly ids: {
    readonly chat: string;
    readonly brief: string;
    readonly landing: string;
    readonly outreach: string;
  };
  readonly json: (value: unknown, status?: number) => Response;
}

type Route = [
  string,
  RegExp,
  (
    request: { readonly body: unknown; readonly query: URLSearchParams },
    match: RegExpMatchArray,
  ) => Response | null,
];

export const DEMO_PET_ID = '0199a000-0000-7000-8000-0000000000c1';
export const DEMO_PET_NAME = 'Pip';
export const SCRIPTED_REPLY =
  'This is the demo, so my replies are scripted. On your own Nix, connect ChatGPT, Anthropic or OpenRouter and I can search, plan and change your workspace — always asking before I write.';

const THINKING_MS = 600;
const SEEDED_AT = '2026-10-01T09:30:00+00:00';
const MEMORY_ID = '0199a000-0000-7000-8000-0000000000c2';
const MEMORY_TEXT = 'Prefers Friday launches';

export const demoPetSettings = (): Json => ({
  enabled: true,
  activePetId: DEMO_PET_ID,
  motion: 'system',
  profiles: [
    {
      id: DEMO_PET_ID,
      name: DEMO_PET_NAME,
      appearance: 'owl',
      personality: 'encouraging',
      responseLength: 'concise',
      instructions: '',
      applyWithoutAsking: false,
      provider: 'anthropic',
    },
  ],
  inlineWriting: false,
  memories: [{ id: MEMORY_ID, text: MEMORY_TEXT, createdAt: SEEDED_AT }],
  memoryMode: 'always',
});

/** The three exchanges, as the chat note stores them and as the pet panel shows them. */
function transcript(env: DemoAiEnv): { user: string; assistant: string }[] {
  const link = (id: string, title: string): string =>
    `[${title}](/w/${env.workspaceId}?item=${id})`;
  const program = [
    'root = Stack([title, facts, plan])',
    'title = Text("Launch week", "title")',
    'facts = Grid([open, high, done], 3)',
    'open = Stat("Open tasks", 6)',
    'high = Stat("High priority open", 3)',
    'done = Stat("Done", 2)',
    'plan = Table(["Day", "Focus", "Owner"], [["Mon", "Landing page and pricing", "Ada"], ["Tue", "Beta tester outreach", "Sam"], ["Wed", "Launch video edit", "Sam"], ["Thu", "Press kit and email", "Ada"], ["Fri", "Launch", "Everyone"]], "Launch week plan")',
  ].join('\n');
  return [
    {
      user: 'What is most likely to slip before launch?',
      assistant: [
        'I searched your workspace by meaning. Three notes matter most:',
        '',
        `- ${link(env.ids.brief, 'Launch brief')} sets the goals: 500 beta sign-ups and no open high-priority tasks on the day.`,
        `- ${link(env.ids.outreach, 'Beta tester outreach')} is high priority and has not started, and sign-ups depend on it.`,
        `- ${link(env.ids.landing, 'Landing page design')} was due yesterday, with the accessibility pass and final screenshots still open.`,
        '',
        'Start with the outreach.',
      ].join('\n'),
    },
    {
      user: 'Lay out launch week as a table.',
      assistant: `Here is launch week, built from your brief.\n\n\`\`\`openui-lang\n${program}\n\`\`\``,
    },
    {
      user: 'Start the beta outreach now, and remember that I prefer Friday launches.',
      assistant: [
        `Done. I set ${link(env.ids.outreach, 'Beta tester outreach')} to In progress after you approved it, and I'll remember you prefer Friday launches.`,
        '',
        `Next up is ${link(env.ids.landing, 'Landing page design')}: its final screenshots are the last blocker.`,
      ].join('\n'),
    },
  ];
}

const tool = (id: string, args: Json, result: string): Json => ({
  id,
  arguments: JSON.stringify({
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
    ...args,
  }),
  status: 'completed',
  result,
  claimId: '',
});

export function createDemoAi(env: DemoAiEnv): Route[] {
  const turns = transcript(env);
  let settings = demoPetSettings();
  let settingsRevision = 1;

  // The chat note: text only, as Core stores it.
  const chatMessages: { id: string; role: string; text: string; seq: string }[] = [];
  const chatMessage = (role: string, text: string): void => {
    chatMessages.push({
      id: `0199a000-0000-7000-8000-${(0x500 + chatMessages.length).toString(16).padStart(12, '0')}`,
      role,
      text,
      seq: String(chatMessages.length + 1).padStart(6, '0'),
    });
  };
  for (const turn of turns) {
    chatMessage('user', turn.user);
    chatMessage('assistant', turn.assistant);
  }
  let chatRevision = 1;
  let chatTurn: Json | null = null;
  const conversation = (): Json => ({
    itemId: env.ids.chat,
    workspaceId: env.workspaceId,
    title: 'Plan launch week with Pip',
    sourceWorkspaceIds: [env.workspaceId],
    petId: DEMO_PET_ID,
    revision: chatRevision,
    canSend: true,
    canEdit: false,
    turn: chatTurn,
  });

  // The pet panel: the same exchange, and the last turn's tools already approved and applied.
  let panelMessages: { id: string; role: string; text: string }[] = turns.flatMap((turn, index) => [
    { id: `m${String(index + 1)}`, role: 'user', text: turn.user },
    { id: `m${String(index + 1)}:assistant`, role: 'assistant', text: turn.assistant },
  ]);
  let panelTools: Json[] = [
    tool(
      't1',
      { operation: 'search', query: 'what could slip before launch' },
      JSON.stringify({
        results: [
          { itemId: env.ids.brief, title: 'Launch brief' },
          { itemId: env.ids.outreach, title: 'Beta tester outreach' },
          { itemId: env.ids.landing, title: 'Landing page design' },
        ],
      }),
    ),
    tool(
      't2',
      {
        operation: 'set_properties',
        itemId: env.ids.outreach,
        propertiesJson: JSON.stringify({ status: 'In progress' }),
      },
      'Done.',
    ),
    tool(
      't3',
      { operation: 'remember', markdown: MEMORY_TEXT },
      JSON.stringify({ remembered: MEMORY_TEXT, alreadyKnown: false }),
    ),
  ];
  let panelRevision = 1;
  let panelState = 'idle';
  const connection = (): Json => ({
    provider: 'anthropic',
    status: 'connected',
    reason: '',
    canConnect: false,
    verificationUrl: '',
    userCode: '',
    state: panelState,
    messages: panelMessages,
    history: [],
    models: [{ id: 'claude-sonnet', name: 'Claude Sonnet', default: true, supportsTools: true }],
    tools: panelTools,
    revision: panelRevision,
    lockedRead: false,
    title: 'Plan launch week with Pip',
  });

  const field = (body: unknown, key: string): unknown =>
    typeof body === 'object' && body !== null ? (body as Json)[key] : undefined;
  const str = (body: unknown, key: string): string => {
    const value = field(body, key);
    return typeof value === 'string' ? value : '';
  };
  const reply = (apply: () => void): void => {
    setTimeout(apply, THINKING_MS);
  };

  const runtime = ({ body }: { readonly body: unknown }): Response => {
    const operation = field(body, 'operation');
    if (operation === 'send') {
      const text = str(body, 'text');
      const from = field(body, 'replaceFromMessageId');
      if (typeof from === 'string') {
        const at = panelMessages.findIndex((message) => message.id === from);
        if (at >= 0) panelMessages = panelMessages.slice(0, at);
      }
      const id = `u${String(panelRevision)}`;
      panelMessages = [...panelMessages, { id, role: 'user', text }];
      panelTools = [];
      panelState = 'thinking';
      panelRevision += 1;
      reply(() => {
        panelMessages = [
          ...panelMessages,
          { id: `${id}:assistant`, role: 'assistant', text: SCRIPTED_REPLY },
        ];
        panelState = 'success';
        panelRevision += 1;
      });
    } else if (operation === 'reset') {
      panelMessages = [];
      panelTools = [];
      panelState = 'idle';
      panelRevision += 1;
    }
    return env.json(connection());
  };
  const watch = (): Response => env.json(connection());

  return [
    [
      'GET',
      /^\/api\/v1\/me\/pets\/settings$/,
      () => env.json({ revision: settingsRevision, settings }),
    ],
    [
      'PUT',
      /^\/api\/v1\/me\/pets\/settings$/,
      ({ body }) => {
        settings = { ...settings, ...(field(body, 'settings') as Json) };
        settingsRevision += 1;
        return env.json({ revision: settingsRevision, settings });
      },
    ],
    [
      'GET',
      /^\/api\/v1\/me\/pets\/providers$/,
      () => env.json({ keys: [{ provider: 'anthropic', keyHint: 'demo', savedAt: SEEDED_AT }] }),
    ],
    ['GET', /^\/api\/v1\/me\/pets\/connection$/, () => env.json(connection())],
    ['POST', /^\/api\/v1\/me\/pets\/runtime(\/note)?$/, runtime],
    ['GET', /^\/api\/v1\/me\/pets\/runtime(\/note)?\/watch$/, watch],
    [
      'GET',
      /^\/api\/v1\/conversations\/([^/]+)$/,
      (_, [, id]) => (id === env.ids.chat ? env.json(conversation()) : null),
    ],
    [
      'GET',
      /^\/api\/v1\/conversations\/([^/]+)\/watch$/,
      (_, [, id]) => (id === env.ids.chat ? env.json(conversation()) : null),
    ],
    [
      'GET',
      /^\/api\/v1\/conversations\/([^/]+)\/messages$/,
      ({ query }, [, id]) => {
        if (id !== env.ids.chat) return null;
        const after = query.get('cursor') ?? '';
        return env.json({
          items: chatMessages
            .filter((message) => message.seq > after)
            .map((message) => ({ ...message, createdAt: SEEDED_AT, authorId: null })),
          nextCursor: null,
        });
      },
    ],
    [
      'POST',
      /^\/api\/v1\/conversations\/([^/]+)\/turns$/,
      ({ body }, [, id]) => {
        if (id !== env.ids.chat) return null;
        const requestId = str(body, 'requestId');
        chatMessage('user', str(body, 'text'));
        chatTurn = {
          id: '0199a000-0000-7000-8000-0000000000d1',
          requestId,
          status: 'running',
          error: null,
          text: '',
        };
        chatRevision += 1;
        reply(() => {
          chatMessage('assistant', SCRIPTED_REPLY);
          chatTurn = { ...chatTurn, status: 'completed' };
          chatRevision += 1;
        });
        return env.json(conversation());
      },
    ],
    [
      'POST',
      /^\/api\/v1\/conversations\/([^/]+)\/cancel$/,
      (_, [, id]) => (id === env.ids.chat ? env.json(conversation()) : null),
    ],
  ];
}
