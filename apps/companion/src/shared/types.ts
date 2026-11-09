export interface Message {
  id: string;
  role: string;
  text: string;
}

export interface SharedItem {
  id: string;
  title: string;
}

export interface WorkspaceMapEntry {
  id: string;
  title: string;
  type: string;
  viewKinds?: string[] | undefined;
}

/** One companion request, as Core's PetWorkerRequest / PetInlineWorkerRequest sends it. */
export interface Request {
  tenantId: string;
  principalId: string;
  workspaceId: string;
  petId: string;
  operation: string;
  provider: string;
  apiKey: string;
  requestId: string;
  text: string;
  instructions: string;
  itemId: string;
  itemTitle: string;
  sharedText: string;
  model: string;
  mode: string;
  workspaceAccess: boolean;
  rootItemId: string;
  conversationItemId: string;
  sourceWorkspaceIds: string[];
  earlierMessages: Message[];
  readOnly: boolean;
  toolId: string;
  toolResult: string;
  toolSuccess: boolean;
  toolLockedContent: boolean;
  toolImage: string;
  historyId: string;
  inlineKind: string;
  contextText: string;
  language: string;
  after: number;
  today: string;
  timeZone: string;
  workspaceMap: WorkspaceMapEntry[];
  items: SharedItem[];
  replaceFromMessageId: string;
}

export function emptyRequest(): Request {
  return {
    tenantId: '',
    principalId: '',
    workspaceId: '',
    petId: '',
    operation: '',
    provider: '',
    apiKey: '',
    requestId: '',
    text: '',
    instructions: '',
    itemId: '',
    itemTitle: '',
    sharedText: '',
    model: '',
    mode: '',
    workspaceAccess: false,
    rootItemId: '',
    conversationItemId: '',
    sourceWorkspaceIds: [],
    earlierMessages: [],
    readOnly: false,
    toolId: '',
    toolResult: '',
    toolSuccess: false,
    toolLockedContent: false,
    toolImage: '',
    historyId: '',
    inlineKind: '',
    contextText: '',
    language: '',
    after: 0,
    today: '',
    timeZone: '',
    workspaceMap: [],
    items: [],
    replaceFromMessageId: '',
  };
}

export interface Model {
  id: string;
  name: string;
  default: boolean;
  supportsTools: boolean;
}

/** A model plus what the account keeps privately (never sent on the wire). */
export interface ModelInfo extends Model {
  supportedEfforts: string[];
  defaultEffort: string;
  textOnly: boolean;
}

/** The persisted and wire part of a tool call: a per-conversation approval receipt. */
export interface ToolCall {
  id: string;
  arguments: string;
  status: string;
  result: string;
  claimId: string;
}

export interface ToolState extends ToolCall {
  rpcId: unknown;
  hasRpcId: boolean;
  pendingSince: number;
  claimedAt: number;
  waiters: unknown[];
  image: string;
}

export interface HistoryEntry {
  id: string;
  title: string;
  createdAt: string;
}

export interface Response {
  provider: string;
  status: string;
  reason: string;
  canConnect: boolean;
  verificationUrl: string;
  userCode: string;
  state: string;
  messages: Message[];
  models: Model[];
  tools: ToolCall[];
  history: HistoryEntry[];
  revision: number;
  lockedRead: boolean;
  title: string;
}

export interface ProviderUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: Level, message: string, attrs?: Record<string, unknown>): void;
}

export type RequestHandler = (
  id: unknown,
  method: string,
  params: unknown,
  bytes: number,
) => boolean;
export type Notify = (method: string, params: unknown) => void;

/** The narrow provider seam: the Codex app-server vocabulary, spoken by a child or in process. */
export interface Transport {
  call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): void;
  alive?(): boolean;
  setRequestHandler?(handler: RequestHandler): void;
  reply?(id: unknown, result: unknown): void;
  setApiKey?(key: string): void;
}

export type Launch = (
  provider: string,
  binary: string,
  home: string,
  apiKey: string,
  notify: Notify,
  trace: boolean,
) => Promise<Transport>;

export type ConversationToolExecutor = (
  signal: AbortSignal,
  conversationId: string,
  tenantId: string,
  principalId: string,
  requestId: string,
  args: string,
) => Promise<{ text: string; success: boolean; lockedContent: boolean }>;
