import type { PetPlanSourceScope } from '@nix/api-client';
import {
  addContextSources,
  HISTORY_SHARING_RECOVERY,
  readProviderContext,
  type ProviderContextProvenance,
} from './context-provenance.ts';
import { createHash, randomUUID } from 'node:crypto';
import { APP_ONLY_OPERATIONS, mayApplyUnasked } from '@nix/companion/auto-apply';
import {
  READ_ONLY_OPERATIONS,
  workspaceToolSchema,
  type WorkspaceToolArgs,
} from '@nix/companion/tool-args';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  Diagnostics,
  conversationKey,
  logSafeError,
  rawSyntaxKinds,
  resultKind,
  traceRaw,
  turnErrorAttrs,
  valueOrDefault,
  type TurnError,
} from '../shared/diagnostics.ts';
import { applyDelta, draftId, trimMessages, withoutDrafts } from '../providers/drafts.ts';
import { SERVER_READ_MS, SERVER_WRITE_MS, type ServerTools } from '../tools/server-tools.ts';
import {
  argumentRefusalCode,
  toolIdentity,
  toolOperation,
  validateToolArguments,
} from '../tools/flatten.ts';
import { instructions, conversationScopeRules, noteScopeRules } from '../tools/instructions.ts';
import { isToolItem, type InlineRun } from '../tools/inline.ts';
import {
  ProviderThreadUnavailableError,
  providerFailureMessage,
} from '../providers/provider-errors.ts';
import {
  conversationToolRefusal,
  flattenConversationToolCall,
  noteScopeToolRefusal,
  workspaceToolsForRequest,
} from '../tools/scope.ts';
import {
  adoptPlanToolsSchema,
  cancelPlanToolsSchema,
  inspectPlanToolsSchema,
  planToolBindingSchema,
  resolvePlanToolSchema,
  supersedePlanToolsSchema,
} from '../tools/plan-rpc.ts';
import { observeRecipientConnection } from '../tools/plan-recipient.ts';
import { TurnTiming } from '../providers/turn-timing.ts';
import {
  emptyRequest,
  type ConversationToolExecutor,
  type HistoryEntry,
  type Logger,
  type Message,
  type Model,
  type ModelInfo,
  type Request,
  type Response,
  type ToolCall,
  type ToolState,
  type Transport,
  type ValidateSharing,
} from '../shared/types.ts';
import {
  aborted,
  byteLen,
  errorMessage,
  goJson,
  isRecord,
  sleep,
  str,
  truncateUtf8,
  UUID,
} from '../shared/util.ts';
import { toolNamesChat } from '../tools/catalog.ts';

/** Older provider threads restart on their next send to receive the current catalog and rules.
 * The replacement thread receives the visible history and inherits its protected-read hold. */
export const TOOL_VERSION = 15;
export const MAX_TOOL_CALLS_PER_TURN = 20;
export const MAX_CONCURRENT_WATCHERS = 4;
export const MIN_WATCH_DWELL_MS = 120;
export const MAX_CONVERSATIONS_PER_ACCOUNT = 128;
export const MAX_HISTORY_ENTRIES = 32;
const HISTORY_READ_CONCURRENCY = 8;
export const STUCK_TURN_MS = 15 * 60 * 1000;
const MAX_EARLIER_RUNES = 8000;
const MAX_FILE_BYTES = 4 << 20;

export class ReplaceTargetError extends Error {
  constructor() {
    super('replace target is not a user message');
  }
}
export class ReplaceBusyError extends Error {
  constructor() {
    super('turn already running');
  }
}

export interface Conversation {
  durableState: string;
  toolVersion: number;
  threadId: string;
  turnId: string;
  requestId: string;
  state: string;
  reason: string;
  messages: Message[];
  workspaceAccess: boolean;
  rootItemId: string;
  conversationItemId: string;
  sourceWorkspaceIds: string[];
  actor: Request;
  readOnly: boolean;
  tools: ToolState[];
  /** The owner's name for this conversation, or the one set at its first send. */
  title: string;
  /** Set once a protected tool result reaches this conversation; only a reset clears it. */
  lockedRead: boolean;
  providerContext?: ProviderContextProvenance | undefined;
  disclosureBlocked: boolean;
  interruptRequested: boolean;
  /** Never persisted: every load gets a clock-seeded one, monotonic across restarts. */
  revision: number;
  timing: TurnTiming;
}

export function newConversation(): Conversation {
  return {
    durableState: '',
    toolVersion: 0,
    threadId: '',
    turnId: '',
    requestId: '',
    state: 'idle',
    reason: '',
    messages: [],
    workspaceAccess: false,
    rootItemId: '',
    conversationItemId: '',
    sourceWorkspaceIds: [],
    actor: emptyRequest(),
    readOnly: false,
    tools: [],
    title: '',
    lockedRead: false,
    disclosureBlocked: false,
    interruptRequested: false,
    revision: 0,
    timing: new TurnTiming(),
  };
}

export interface HistoryArchive extends HistoryEntry {
  messages: Message[];
  tools: ToolCall[];
  lockedRead?: boolean | undefined;
  providerContext?: ProviderContextProvenance | undefined;
}

export interface AccountOptions {
  home: string;
  provider: string;
  transport: Transport;
  chatEffort: string;
  logger: Logger | undefined;
  trace: boolean;
  executeConversationTool?: ConversationToolExecutor | undefined;
  serverTools?: ServerTools | undefined;
  validateSharing?: ValidateSharing | undefined;
}

const publicTool = (t: ToolState): ToolCall => ({
  id: t.id,
  arguments: t.arguments,
  status: t.status,
  result: t.result,
  claimId: t.claimId,
  ...(t.planBinding === undefined ? {} : { planBinding: t.planBinding }),
});

function newTool(call: ToolCall): ToolState {
  return {
    ...call,
    rpcId: undefined,
    hasRpcId: false,
    pendingSince: 0,
    claimedAt: 0,
    waiters: [],
    image: '',
  };
}

function toolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter(isRecord).map((t) => ({
    id: str(t.id),
    arguments: str(t.arguments),
    status: str(t.status),
    result: str(t.result),
    claimId: str(t.claimId),
    ...(planToolBindingSchema.safeParse(t.planBinding).success
      ? { planBinding: planToolBindingSchema.parse(t.planBinding) }
      : {}),
  }));
}

function messages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .filter(isRecord)
    .map((m) => ({ id: str(m.id), role: str(m.role), text: str(m.text) }));
}

/** defaultTitle names a conversation after its first user message: whitespace collapsed, 120 runes. */
export function defaultTitle(list: Message[]): string {
  const first = list.find((m) => m.role === 'user');
  if (first === undefined) return '';
  return Array.from(
    first.text
      .split(/\s+/)
      .filter((w) => w !== '')
      .join(' '),
  )
    .slice(0, 120)
    .join('');
}

/** Where the message with this id sits when it is the last user message; else -1. */
export function replaceIndex(list: Message[], id: string): number {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') return list[i]?.id === id ? i : -1;
  }
  return -1;
}

/** The final user and assistant messages as plain text, oldest whole messages dropped to fit. */
export function earlierTranscript(list: Message[]): string {
  const lines: string[] = [];
  for (const m of list) {
    if (m.role === 'system' || m.id.includes(':commentary:') || m.id.includes(':draft:')) continue;
    lines.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.text}`);
  }
  let kept = 0;
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    used += Array.from(lines[i] ?? '').length + 2;
    if (used - 2 > MAX_EARLIER_RUNES) break;
    kept++;
  }
  return lines.slice(lines.length - kept).join('\n\n');
}

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path);
  if (raw.length > MAX_FILE_BYTES) throw new Error('too large');
  return JSON.parse(raw.toString('utf8')) as unknown;
}

/** turnPrompt is the JSON object one user turn sends the model. */
export function turnPrompt(
  r: Request,
  earlier: string,
  newThread: boolean,
): Record<string, unknown> {
  const prompt: Record<string, unknown> = {
    message: r.text,
    workspaceId: r.workspaceId,
    currentItemId: r.itemId,
    currentItemTitle: r.itemTitle,
    sharedText: r.sharedText,
    workspaceAccess: r.workspaceAccess,
    today: r.today,
    timeZone: r.timeZone,
  };
  if (r.conversationItemId !== '') {
    prompt.conversationItemId = r.conversationItemId;
    prompt.sourceWorkspaceIds = r.sourceWorkspaceIds;
    prompt.readOnly = true;
  }
  if (r.items.length > 1) prompt.sharedItems = r.items;
  if (r.conversationItemId !== '' && newThread) prompt.earlierMessages = r.earlierMessages;
  if (earlier !== '' && newThread) prompt.earlierMessages = earlier;
  if (r.rootItemId !== '') {
    prompt.rootItemId = r.rootItemId;
    prompt.readOnly = r.readOnly;
  }
  if (
    newThread &&
    r.conversationItemId === '' &&
    r.rootItemId === '' &&
    r.workspaceMap.length > 0
  ) {
    prompt.workspaceMap = r.workspaceMap;
  }
  return prompt;
}

/** One principal's provider process (or in-process transport) and its conversations. */
export const MODEL_CACHE_MS = 5 * 60 * 1000;

export class Account {
  readonly provider: string;
  readonly home: string;
  readonly transport: Transport;
  readonly diag: Diagnostics;
  readonly conversations = new Map<string, Conversation>();
  private readonly chatEffort: string;
  private readonly executeConversationTool: ConversationToolExecutor | undefined;
  private readonly sourceScopes = new Map<string, PetPlanSourceScope>();
  private readonly recipientRevisions = new Map<string, string>();
  private readonly validateSharing: ValidateSharing | undefined;
  private readonly serverTools: ServerTools | undefined;
  models: ModelInfo[] = [];
  private modelsListedAt = 0;
  private modelsKey = '';
  status = 'disconnected';
  reason = '';
  last = Date.now();
  private loginId = '';
  private url = '';
  private code = '';
  /** Serialises state transitions: a second mutating request is refused as busy, not queued. */
  opBusy = false;
  watchers = 0;
  inlineStreams = 0;
  private readonly inline = new Map<string, InlineRun>();
  private readonly changeWaiters = new Set<() => void>();

  constructor(options: AccountOptions) {
    this.provider = options.provider;
    this.validateSharing = options.validateSharing;
    this.home = options.home;
    this.transport = options.transport;
    this.chatEffort = options.chatEffort;
    this.executeConversationTool = options.executeConversationTool;
    this.serverTools = options.serverTools;
    this.diag = new Diagnostics(options.home, options.logger, options.trace);
    mkdirSync(options.home, { recursive: true, mode: 0o700 });
    // A throw here would escape the transport's stdout listener or turn loop and stop the whole
    // service (deeply nested model arguments overflow the stack in goJson): refuse the call instead.
    this.transport.setRequestHandler?.((id, method, params, bytes) => {
      try {
        return this.toolRequest(id, method, params, bytes);
      } catch {
        return false;
      }
    });
  }

  // ---- watchers and inline slots ----

  tryAcquireWatcher(): boolean {
    if (this.watchers + 1 > MAX_CONCURRENT_WATCHERS) return false;
    this.watchers++;
    return true;
  }

  releaseWatcher(): void {
    this.watchers--;
  }

  tryAcquireInline(): boolean {
    if (this.inlineStreams + 1 > 2) return false;
    this.inlineStreams++;
    return true;
  }

  releaseInline(): void {
    this.inlineStreams--;
  }

  registerInline(thread: string, run: InlineRun): void {
    this.inline.set(thread, run);
  }

  unregisterInline(thread: string): void {
    this.inline.delete(thread);
  }

  /** Marks c as changed and wakes every watcher. Called from save and at every unsaved mutation. */
  bump(c: Conversation): void {
    c.revision = Math.max(Date.now(), c.revision + 1);
    for (const wake of [...this.changeWaiters]) wake();
  }

  private waitForBump(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.changeWaiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.changeWaiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * Blocks until key's conversation revision exceeds `after`, the signal aborts, or the timeout
   * elapses. It never touches the transport. When after != 0 it never returns on a revision
   * change sooner than MIN_WATCH_DWELL_MS after it started (a streaming client cannot receive
   * more than about 8 snapshots a second); after == 0 returns as soon as a conversation exists.
   */
  async awaitChange(
    signal: AbortSignal,
    key: string,
    after: number,
    timeoutMs: number,
  ): Promise<void> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    for (;;) {
      const c = this.conversations.get(key);
      if (c === undefined || c.revision > after) {
        if (after === 0) return;
        const remaining = MIN_WATCH_DWELL_MS - (Date.now() - start);
        if (remaining > 0) await sleep(remaining, signal);
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted) return;
      await this.waitForBump(remaining, signal);
      if (aborted(signal)) return;
    }
  }

  /**
   * The 15-minute "thinking" timeout the plain read and the watch share: a conversation stuck
   * mid-turn is interrupted and marked as an error so the client can retry. It never blocks: when a
   * send or tool operation is using the transport, it skips the cleanup this time.
   */
  async expireStaleThinking(signal: AbortSignal, key: string, c: Conversation): Promise<void> {
    const expired = c.state === 'thinking' && Date.now() - c.timing.started > STUCK_TURN_MS;
    if (!expired || this.opBusy) return;
    this.opBusy = true;
    try {
      this.cancelTools(key);
      await this.transport
        .call('turn/interrupt', { threadId: c.threadId, turnId: c.turnId }, signal)
        .catch(() => undefined);
      c.state = 'error';
      c.reason = 'The response timed out. You can send another message.';
      this.bump(c);
    } finally {
      this.opBusy = false;
    }
  }

  // ---- persistence ----

  private path(key: string): string {
    return join(this.home, `${key}.json`);
  }

  /** Restores key's conversation from disk (or starts an empty one), once. */
  load(key: string): void {
    if (this.conversations.has(key)) return;
    if (this.conversations.size >= MAX_CONVERSATIONS_PER_ACCOUNT)
      throw new Error('conversation capacity reached');
    const c = newConversation();
    let raw: unknown;
    let exists = true;
    try {
      raw = readJsonFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else if (error instanceof SyntaxError || (error as Error).message === 'too large')
        throw new Error('conversation could not be restored');
      else throw error;
    }
    if (exists) {
      if (!isRecord(raw)) throw new Error('conversation could not be restored');
      c.durableState = str(raw.durableState);
      c.toolVersion = typeof raw.toolVersion === 'number' ? raw.toolVersion : 0;
      c.threadId = str(raw.threadId);
      c.requestId = str(raw.requestId);
      c.reason = str(raw.reason);
      c.messages = messages(raw.messages);
      c.rootItemId = str(raw.rootItemId);
      c.conversationItemId = str(raw.conversationItemId);
      c.sourceWorkspaceIds = Array.isArray(raw.sourceWorkspaceIds)
        ? (raw.sourceWorkspaceIds as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
      c.readOnly = raw.readOnly === true;
      c.tools = toolCalls(raw.tools).map(newTool);
      c.title = str(raw.title);
      c.lockedRead = raw.lockedRead === true;
      c.providerContext = readProviderContext(raw.providerContext);
      c.disclosureBlocked = raw.disclosureBlocked === true;
      c.state = 'idle';
      if (c.conversationItemId !== '') {
        c.state = c.durableState;
        if (c.state === '' || c.state === 'thinking') {
          c.state = 'error';
          c.reason =
            'The worker restarted before this response completed. Retry to continue from saved messages.';
        }
      }
      for (const t of c.tools) {
        if (['pending', 'claimed', 'planned', 'adopted'].includes(t.status)) {
          t.status = 'interrupted';
          t.result = 'Worker restarted. Check Nix before requesting this change again.';
        }
      }
      if (c.disclosureBlocked) {
        c.state = 'error';
        c.reason = HISTORY_SHARING_RECOVERY;
      }
    }
    c.revision = Date.now();
    this.conversations.set(key, c);
  }

  /** Writes a bounded provider conversation cache through a synced temp file and a rename. */
  save(key: string): void {
    const c = this.conversations.get(key);
    if (c === undefined) return;
    this.bump(c);
    // A streaming draft is never durable. Omit-empty members as the Go encoder wrote them.
    const persisted: Record<string, unknown> = {
      ...(c.conversationItemId !== '' ? { durableState: c.state } : {}),
      toolVersion: c.toolVersion,
      threadId: c.threadId,
      requestId: c.requestId,
      ...(c.reason !== '' ? { reason: c.reason } : {}),
      messages: withoutDrafts(c.messages),
      ...(c.rootItemId !== '' ? { rootItemId: c.rootItemId } : {}),
      ...(c.conversationItemId !== '' ? { conversationItemId: c.conversationItemId } : {}),
      ...(c.sourceWorkspaceIds.length > 0 ? { sourceWorkspaceIds: c.sourceWorkspaceIds } : {}),
      ...(c.readOnly ? { readOnly: true } : {}),
      tools: c.tools.map(publicTool),
      ...(c.title !== '' ? { title: c.title } : {}),
      ...(c.lockedRead ? { lockedRead: true } : {}),
      ...(c.providerContext === undefined ? {} : { providerContext: c.providerContext }),
      ...(c.disclosureBlocked ? { disclosureBlocked: true } : {}),
    };
    writeFileAtomic(this.path(key), `${JSON.stringify(persisted)}\n`);
  }

  snapshot(key: string): Response {
    const r: Response = {
      provider: this.provider,
      status: this.status,
      reason: this.reason,
      canConnect: this.status !== 'connected',
      verificationUrl: this.url,
      userCode: this.code,
      state: 'idle',
      messages: [],
      models: this.models.map(publicModel),
      tools: [],
      history: [],
      revision: 0,
      lockedRead: false,
      title: '',
      // Left out when off, so the wire is what it was.
      ...(this.serverTools?.mode === 'all' ? { serverWrites: true } : {}),
    };
    const c = this.conversations.get(key);
    if (c !== undefined) {
      r.state = c.state;
      if (c.state === 'error' && c.reason !== '') r.reason = c.reason;
      r.messages = c.messages.map((m) => ({ ...m }));
      r.tools = c.tools.map(publicTool);
      r.revision = c.revision;
      if (c.requestId !== '') r.turnId = c.requestId;
      r.conversationId = key;
      const plannedTools = c.tools.filter((tool) => tool.status === 'planned');
      if (plannedTools.length > 0) {
        const batches = new Map<string, { expected: number; actual: number }>();
        for (const tool of plannedTools) {
          const batchId = tool.planBatchId ?? tool.id;
          const batch = batches.get(batchId) ?? { expected: tool.planBatchSize ?? 1, actual: 0 };
          batch.actual += tool.planBatchSeen ?? 1;
          batches.set(batchId, batch);
        }
        const sourceScope = this.sourceScopes.get(c.requestId);
        r.plannedBatch = {
          turnId: c.requestId,
          conversationId: key,
          toolIds: plannedTools.map((tool) => tool.id),
          ready: [...batches.values()].every((batch) => batch.actual === batch.expected),
          scope: { rootItemId: c.rootItemId === '' ? null : c.rootItemId, readOnly: c.readOnly },
          requiresReadDecision:
            !c.actor.readWithoutAsking &&
            plannedTools.some((tool) =>
              READ_ONLY_OPERATIONS.has(
                toolOperation(tool.arguments) as WorkspaceToolArgs['operation'],
              ),
            ),
          ...(sourceScope === undefined ? {} : { sourceScope }),
        };
      }
      r.lockedRead = c.lockedRead;
      r.title = c.title === '' ? defaultTitle(c.messages) : c.title;
    }
    return r;
  }

  async canDisclose(r: Request): Promise<boolean> {
    if (this.validateSharing === undefined) return false;
    const conversation = this.conversations.get(conversationKey(r));
    if (conversation?.disclosureBlocked === true) return false;
    const context = conversation?.providerContext;
    if (
      conversation !== undefined &&
      conversation.requestId !== r.requestId &&
      (conversation.threadId !== '' || conversation.messages.length > 0) &&
      context === undefined
    )
      return false;
    const decision = await this.validateSharing(
      {
        tenantId: r.tenantId,
        principalId: r.principalId,
        workspaceId: r.workspaceId,
        petId: r.petId,
        provider: this.provider,
        turnId: r.requestId,
        attestation: r.sharingAttestation,
        ...(context === undefined
          ? {}
          : {
              contextSourceItemIds: context.sourceItemIds,
              contextProtected: context.protectedRead,
              contextUnbounded: context.unbounded,
              priorRecipientRevision: context.recipientRevision,
              priorTurnId: context.turnId,
              priorSourceScope: context.sourceScope,
            }),
      },
      AbortSignal.timeout(10_000),
    );
    if (typeof decision === 'boolean' || !decision.allowed || decision.recipientRevision === null)
      return false;
    if (context !== undefined && context.recipientRevision !== decision.recipientRevision)
      return false;
    const pinned = this.recipientRevisions.get(r.requestId);
    if (pinned !== undefined && pinned !== decision.recipientRevision) return false;
    if (this.recipientRevisions.size >= 128 && pinned === undefined) {
      const oldest = this.recipientRevisions.keys().next().value;
      if (oldest !== undefined) {
        this.recipientRevisions.delete(oldest);
        this.sourceScopes.delete(oldest);
      }
    }
    this.recipientRevisions.set(r.requestId, decision.recipientRevision);
    if (decision.sourceScope !== undefined)
      this.sourceScopes.set(r.requestId, decision.sourceScope);
    return true;
  }

  recipientRevisionFor(r: Request): string | undefined {
    return this.recipientRevisions.get(r.requestId);
  }

  // ---- operations ----

  async handle(signal: AbortSignal, r: Request): Promise<Response> {
    const op = r.operation;
    if (op === 'models') {
      await this.listModels(signal);
    } else if (op === 'connect' && this.provider !== 'chatgpt') {
      // A key provider "connects" by proving the key: one model listing, nothing stored here.
      try {
        await this.listModels(signal);
      } catch (error) {
        this.status = 'error';
        this.reason = errorMessage(error);
        return this.snapshot('');
      }
      this.status = 'connected';
      this.reason = 'API key accepted.';
    } else if (op === 'connect') {
      if (this.loginId === '') {
        const login = await this.transport.call(
          'account/login/start',
          { type: 'chatgptDeviceCode' },
          signal,
        );
        const o = isRecord(login) ? login : {};
        if (
          o.verificationUrl !== 'https://auth.openai.com/codex/device' ||
          str(o.userCode).length > 32 ||
          byteLen(str(o.userCode)) > 32
        ) {
          throw new Error('invalid device login');
        }
        this.loginId = str(o.loginId);
        this.url = str(o.verificationUrl);
        this.code = str(o.userCode);
        this.status = 'connecting';
        this.reason =
          'Open the sign-in page and enter the code. Device-code login must be enabled in ChatGPT security settings.';
      }
    } else if (op === 'disconnect') {
      const active = [...this.conversations.values()]
        .filter((c) => c.turnId !== '')
        .map((c) => ({ threadId: c.threadId, turnId: c.turnId }));
      for (const turn of active) await this.transport.call('turn/interrupt', turn, signal);
      if (this.loginId !== '')
        await this.transport.call('account/login/cancel', { loginId: this.loginId }, signal);
      await this.transport.call('account/logout', {}, signal);
      if (this.provider === 'chatgpt') observeRecipientConnection(this.home, null);
      this.status = 'disconnected';
      this.loginId = '';
      this.url = '';
      this.code = '';
      this.reason = 'ChatGPT disconnected.';
    } else if (op === 'status') {
      const result = await this.transport.call('account/read', { refreshToken: false }, signal);
      if (!isRecord(result)) throw new Error('invalid account status');
      const type = isRecord(result.account) ? str(result.account.type) : undefined;
      if (this.provider === 'chatgpt')
        observeRecipientConnection(this.home, type === 'chatgpt' ? result.account : null);
      if (type === 'chatgpt') {
        this.status = 'connected';
        this.reason = "ChatGPT connected. Messages use your account's Codex allowance.";
        this.loginId = '';
        this.url = '';
        this.code = '';
      } else if (type === 'apiKey') {
        this.status = 'connected';
        this.reason = 'API key saved. Messages are billed to that key.';
      } else if (this.provider !== 'chatgpt') {
        this.status = 'disconnected';
        this.reason = 'Add an API key for this provider in Settings > Pets.';
      } else if (this.loginId === '') {
        this.status = 'disconnected';
        this.reason = 'Connect your ChatGPT account to talk with your companion.';
      }
    } else {
      return this.handleConversation(signal, r);
    }
    return this.snapshot('');
  }

  private async handleConversation(signal: AbortSignal, r: Request): Promise<Response> {
    const op = r.operation;
    const key = conversationKey(r);
    this.foldDesign(key);
    if (
      op === 'history' ||
      op === 'read_history' ||
      op === 'delete_history' ||
      (op === 'rename' && r.historyId !== '')
    ) {
      return await this.history(key, r);
    }
    this.load(key);
    const c = this.conversations.get(key);
    if (c === undefined) throw new Error('conversation could not be restored');
    const state = c.state;
    if (op === 'tool_approve') {
      this.approveTool(key, r);
    } else if (op.startsWith('tool_')) {
      await this.resolveDisclosedTool(key, r);
    } else if (op === 'send') {
      const duplicate = c.requestId === r.requestId;
      if (state === 'thinking' && !duplicate) {
        if (r.replaceFromMessageId !== '') throw new ReplaceBusyError();
        throw new Error('turn already running');
      }
      if (
        !duplicate &&
        r.replaceFromMessageId !== '' &&
        replaceIndex(c.messages, r.replaceFromMessageId) < 0
      ) {
        throw new ReplaceTargetError();
      }
      if (!duplicate) await this.send(signal, key, r);
    } else if (op === 'interrupt') {
      this.cancelTools(key);
      if (c.turnId !== '')
        await this.transport.call(
          'turn/interrupt',
          { threadId: c.threadId, turnId: c.turnId },
          signal,
        );
    } else if (op === 'reset') {
      if (state === 'thinking') throw new Error('stop the running turn first');
      this.archive(key);
      this.conversations.set(key, newConversation());
      this.save(key);
    } else if (op === 'resume_history') {
      this.resume(key, r);
    } else if (op === 'rename') {
      this.renameLive(key, r);
    } else if (op === 'watch') {
      // Never touches the transport before this; only waits for a bump, the request to end, or its
      // own timeout. Then the same 15-minute expiry check a plain read runs.
      await this.awaitChange(signal, key, r.after, 20_000);
      await this.expireStaleThinking(signal, key, c);
    } else if (state === 'thinking') {
      await this.expireStaleThinking(signal, key, c);
    }
    return this.snapshot(key);
  }

  // ---- models ----

  async listModels(signal: AbortSignal): Promise<void> {
    const page = await this.transport.call(
      'model/list',
      { limit: 100, includeHidden: false },
      signal,
    );
    const data = isRecord(page) && Array.isArray(page.data) ? (page.data as unknown[]) : undefined;
    if (data === undefined || data.length > 100 || JSON.stringify(page).length > 256 << 10)
      throw new Error('invalid model catalog');
    const models: ModelInfo[] = [];
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      const id = str(entry.model);
      if (id === '' || byteLen(id) > 160 || byteLen(str(entry.displayName)) > 200) continue;
      const efforts = (
        Array.isArray(entry.supportedReasoningEfforts)
          ? (entry.supportedReasoningEfforts as unknown[])
          : []
      )
        .map((e) => (isRecord(e) ? str(e.reasoningEffort) : ''))
        .filter((e) => e !== '' && byteLen(e) <= 40);
      models.push({
        id,
        name: str(entry.displayName),
        default: entry.isDefault === true,
        supportsTools:
          entry.supportsTools === undefined ||
          entry.supportsTools === null ||
          entry.supportsTools === true,
        supportedEfforts: efforts,
        defaultEffort: str(entry.defaultReasoningEffort),
        textOnly: false,
      });
    }
    this.models = models;
    this.modelsListedAt = Date.now();
  }

  /** The cached list unless it is empty, older than MODEL_CACHE_MS or listed under another key. */
  private async freshModels(signal: AbortSignal, apiKey: string): Promise<boolean> {
    const key = createHash('sha256').update(apiKey).digest('hex');
    if (
      this.models.length > 0 &&
      key === this.modelsKey &&
      Date.now() - this.modelsListedAt < MODEL_CACHE_MS
    )
      return false;
    await this.listModels(signal);
    this.modelsKey = key;
    return true;
  }

  /**
   * The "effort" to send on turn/start: the owner's configured chatEffort, only when the effective
   * model actually advertises it. Never fails the turn: any problem means an empty result.
   */
  async effortFor(signal: AbortSignal, explicitModel: string): Promise<string> {
    const configured = this.chatEffort;
    if (configured === '') return '';
    if (this.models.length === 0) {
      try {
        await this.listModels(signal);
      } catch {
        return '';
      }
    }
    const effective = this.models.find((m) =>
      explicitModel !== '' ? m.id === explicitModel : m.default,
    );
    return effective?.supportedEfforts.includes(configured) === true ? configured : '';
  }

  // ---- send ----

  private async send(signal: AbortSignal, key: string, r: Request): Promise<void> {
    if (!(await this.canDisclose(r))) {
      const current = this.conversations.get(key);
      const message =
        current !== undefined && (current.messages.length > 0 || current.threadId !== '')
          ? HISTORY_SHARING_RECOVERY
          : 'Sharing consent must be reviewed before sending this content.';
      if (current !== undefined) {
        current.state = 'error';
        current.reason = message;
        this.save(key);
      }
      throw new Error(message);
    }
    const c = this.conversations.get(key);
    if (c === undefined) return;
    let thread = c.threadId;
    let earlier = '';
    if (r.conversationItemId !== '') {
      thread = '';
      c.messages = r.earlierMessages.map((m) => ({ ...m }));
    }
    if (c.toolVersion !== TOOL_VERSION || c.readOnly !== r.readOnly) thread = '';
    if (r.replaceFromMessageId !== '') {
      // The provider thread still holds the replaced turn, so the model starts a fresh one and is
      // given the visible messages that stay.
      thread = '';
      earlier = earlierTranscript(
        c.messages.slice(0, Math.max(replaceIndex(c.messages, r.replaceFromMessageId), 0)),
      );
    } else if (
      r.conversationItemId === '' &&
      (c.threadId === '' || (thread === '' && c.readOnly === r.readOnly)) &&
      c.messages.length > 0
    ) {
      // Restore visible context when starting a replacement provider thread.
      earlier = earlierTranscript(c.messages);
    }
    const params: Record<string, unknown> = {
      cwd: join(this.home, 'empty'),
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      baseInstructions: instructions() + noteScopeRules(r) + conversationScopeRules(r),
      developerInstructions: r.instructions,
    };
    let supportsTools = true;
    if (r.model !== '' || (this.provider !== '' && this.provider !== 'chatgpt')) {
      const fetched = await this.freshModels(signal, r.apiKey);
      const pick = () => {
        const selected =
          r.model !== ''
            ? r.model
            : ((this.models.find((m) => m.default) ?? this.models[0])?.id ?? '');
        return this.models.find((m) => m.id === selected);
      };
      let found = pick();
      if (found === undefined && !fetched) {
        // The cached list may be stale: list once more before refusing.
        await this.listModels(signal);
        found = pick();
      }
      if (found === undefined) throw new Error('model is unavailable');
      supportsTools = found.supportsTools;
      if (!supportsTools && r.workspaceAccess) {
        // Said rather than silently dropping the tools: a reply that never reads or writes anything
        // while claiming it did would be worse.
        c.state = 'error';
        c.reason =
          'This model cannot use tools. Pick another model, or turn Workspace access off for this message.';
        this.bump(c);
        throw new Error('model does not support tools');
      }
      params.model = found.id;
    }
    let method = thread === '' ? 'thread/start' : 'thread/resume';
    let started: unknown;
    try {
      if (method === 'thread/resume') {
        if (this.provider !== '' && this.provider !== 'chatgpt')
          params.dynamicTools = supportsTools ? workspaceToolsForRequest(r) : [];
        try {
          started = await this.transport.call(method, { ...params, threadId: thread }, signal);
        } catch (error) {
          if (!(error instanceof ProviderThreadUnavailableError) || signal.aborted) throw error;
          method = 'thread/start';
        }
      }
      if (method === 'thread/start') {
        if (supportsTools) params.dynamicTools = workspaceToolsForRequest(r);
        started = await this.transport.call(method, params, signal);
      }
    } catch (error) {
      this.diag.record(key, 'warn', 'turn.start_failed', {
        step: method,
        error: logSafeError(error),
      });
      throw error;
    }
    thread = isRecord(started) && isRecord(started.thread) ? str(started.thread.id) : '';
    if (thread === '') throw new Error('invalid thread response');
    const prompt = goJson(turnPrompt(r, earlier, method === 'thread/start'));
    // A stale, previously used conversation that is only now catching up to the current tool
    // version had its thread dropped above; tell the user before replacing their state below.
    if (
      r.conversationItemId === '' &&
      c.threadId !== '' &&
      c.toolVersion !== 0 &&
      c.toolVersion !== TOOL_VERSION
    ) {
      c.messages.push({
        id: `${r.requestId}:tools`,
        role: 'system',
        text: 'Your pet was updated and starts a fresh conversation.',
      });
    }
    if (c.threadId !== '' && c.readOnly !== r.readOnly) {
      c.messages.push({
        id: `${r.requestId}:access`,
        role: 'system',
        text: 'Chat access changed. The pet will read this note again as needed.',
      });
    }
    // Internal provider-thread replacement keeps the visible conversation and its read hold.
    c.threadId = thread;
    c.toolVersion = TOOL_VERSION;
    c.requestId = r.requestId;
    c.state = 'thinking';
    c.interruptRequested = false;
    c.reason = '';
    c.workspaceAccess = r.workspaceAccess;
    c.rootItemId = r.rootItemId;
    c.conversationItemId = r.conversationItemId;
    c.sourceWorkspaceIds = [...r.sourceWorkspaceIds];
    const sourceScope = this.sourceScopes.get(r.requestId);
    const recipientRevision = this.recipientRevisionFor(r);
    if (sourceScope !== undefined && recipientRevision !== undefined) {
      c.providerContext = {
        recipientRevision,
        turnId: r.requestId,
        sourceScope,
        sourceItemIds: c.providerContext?.sourceItemIds ?? [],
        protectedRead: c.lockedRead || (c.providerContext?.protectedRead ?? false),
        unbounded: c.providerContext?.unbounded ?? false,
      };
      addContextSources(
        c.providerContext,
        [
          ...r.items.map((item) => item.id),
          ...r.workspaceMap.map((item) => item.id),
          ...(sourceScope.itemIds ?? []),
          ...[r.itemId, r.rootItemId, r.conversationItemId].filter((id) => id !== ''),
        ],
        c.lockedRead,
        false,
      );
    }
    // The turn token is held only when this companion runs server tools, and only for the turn.
    c.actor = {
      ...r,
      apiKey: '',
      earlierMessages: [],
      turnToken: this.serverTools === undefined ? '' : r.turnToken,
    };
    c.readOnly = r.readOnly;
    c.tools = [];
    c.timing.start(r.model, '');
    if (r.replaceFromMessageId !== '') {
      const cut = replaceIndex(c.messages, r.replaceFromMessageId);
      if (cut >= 0) c.messages = c.messages.slice(0, cut);
    }
    c.messages.push({ id: r.requestId, role: 'user', text: r.text });
    c.messages = trimMessages(c.messages, 16);
    if (c.title === '') c.title = defaultTitle(c.messages);
    this.save(key);
    const turnParams: Record<string, unknown> = {
      threadId: thread,
      input: [{ type: 'text', text: prompt }],
    };
    const effort = await this.effortFor(signal, r.model);
    if (effort !== '') {
      turnParams.effort = effort;
      c.timing.effort = effort;
    }
    this.diag.record(
      key,
      'info',
      'turn.started',
      {
        model: valueOrDefault(r.model),
        effort: c.timing.effort,
        thread: method === 'thread/start' ? 'new' : 'resumed',
        tool_version: TOOL_VERSION,
        workspace_access: r.workspaceAccess,
        message_chars: byteLen(r.text),
        shared_chars: byteLen(r.sharedText),
      },
      { prompt: JSON.parse(prompt) as unknown, instructions: r.instructions },
    );
    let turn: unknown;
    let disclosureConfirmed = false;
    try {
      if (!(await this.canDisclose(r))) throw new Error(HISTORY_SHARING_RECOVERY);
      disclosureConfirmed = true;
      this.transport.setDisclosureGuard?.(thread, () => this.canDisclose(c.actor));
      turnParams.consentMode = r.consentMode;
      turnParams.recipientRevision = this.recipientRevisionFor(r);
      turn = await this.transport.call('turn/start', turnParams, signal);
    } catch (error) {
      this.diag.record(key, 'warn', 'turn.start_failed', {
        step: 'turn/start',
        error: logSafeError(error),
      });
      c.actor.turnToken = '';
      c.turnId = '';
      c.state = 'error';
      if (!disclosureConfirmed) c.disclosureBlocked = true;
      c.reason = disclosureConfirmed
        ? 'The response could not start. Check the selected model and ChatGPT connection, then retry.'
        : HISTORY_SHARING_RECOVERY;
      this.trySave(key);
      throw error;
    }
    if (!isRecord(turn)) throw new Error('invalid turn response');
    c.turnId = isRecord(turn.turn) ? str(turn.turn.id) : '';
  }

  // ---- notifications ----

  /** Handles one notification from the provider (a Codex notification or its in-process twin). */
  notify(method: string, params: unknown): void {
    const p = isRecord(params) ? params : {};
    if (this.provider === 'chatgpt' && method === 'account/updated')
      observeRecipientConnection(this.home, isRecord(p.account) ? p.account : null);
    if (method === 'account/login/completed') {
      this.loginId = '';
      this.url = '';
      this.code = '';
      if (p.success === true) {
        if (this.provider === 'chatgpt')
          observeRecipientConnection(this.home, { connection: randomUUID() });
        this.status = 'connected';
        this.reason = 'ChatGPT connected.';
      } else {
        this.status = 'error';
        this.reason = 'Sign-in did not complete. Try connecting again.';
      }
      return;
    }
    const threadId = str(p.threadId);
    const item = isRecord(p.item) ? p.item : {};
    const itemType = str(item.type);
    const phase = str(item.phase);
    const turn = isRecord(p.turn) ? p.turn : {};
    const turnError = turnErrorOf(turn.error);
    if (threadId === '') {
      // Account-level notifications belong to no conversation: traced for debugging, never logged.
      if (this.diag.trace && method !== 'account/rateLimits/updated') {
        this.diag.record(
          '',
          'debug',
          'provider.notification',
          { method },
          { params: traceRaw(params) },
        );
      }
      return;
    }
    const failure =
      turnError?.nixProviderError === 'nix.sharing_blocked'
        ? HISTORY_SHARING_RECOVERY
        : turnError === undefined
          ? ''
          : providerFailureMessage(this.provider, turnError.nixProviderError);
    const run = this.inline.get(threadId);
    if (
      failure !== '' &&
      run !== undefined &&
      method === 'turn/completed' &&
      turnError !== undefined
    ) {
      const token = turnError.nixProviderError;
      this.diag.record('', 'warn', 'inline.provider_failed', {
        operation: 'inline',
        provider_error: token,
        http_status: token.slice(token.lastIndexOf('.') + 1),
      });
    }
    if (run !== undefined) {
      this.routeInline(run, method, itemType, str(p.delta), str(turn.status), failure);
      return;
    }
    for (const [key, c] of this.conversations) {
      if (c.threadId !== threadId) continue;
      if (
        method === 'item/agentMessage/delta' &&
        c.state === 'thinking' &&
        applyDelta(c.messages, c.requestId, str(p.itemId), str(p.delta))
      ) {
        if (str(p.delta) !== '') c.timing.textArrived();
        this.bump(c);
      }
      this.recordNotification(
        key,
        method,
        params,
        itemType,
        phase,
        str(item.text),
        turnErrorOf(p.error),
        p.willRetry === true,
      );
      const itemId = str(item.id);
      if (method === 'item/completed' && itemType === 'agentMessage' && byteLen(itemId) <= 200) {
        // The draft is only ever provisional; the commentary or final message replaces it.
        const id = draftId(c.requestId, itemId);
        const at = c.messages.findIndex((m) => m.id === id);
        if (at >= 0) c.messages.splice(at, 1);
      }
      if (method === 'item/completed' && itemType === 'agentMessage' && phase === 'commentary') {
        const text = str(item.text).trim();
        if (c.state !== 'thinking' || text === '' || byteLen(text) > 8000 || byteLen(itemId) > 200)
          continue;
        const id = `${c.requestId}:commentary:${createHash('sha256').update(itemId).digest('hex').slice(0, 32)}`;
        const last = c.messages[c.messages.length - 1];
        const seen =
          (last?.role === 'assistant' && last.text === text) || c.messages.some((m) => m.id === id);
        if (!seen) {
          c.messages.push({ id, role: 'assistant', text });
          c.messages = trimMessages(c.messages, 40);
          this.trySave(key);
        }
      }
      if (method === 'item/completed' && itemType === 'agentMessage' && phase !== 'commentary') {
        // The final answer is plain text: a JSON-shaped reply is used exactly as written.
        c.messages.push({
          id: `${c.requestId}:assistant`,
          role: 'assistant',
          text: truncateUtf8(str(item.text), 32000),
        });
        this.bump(c);
      }
      if (method === 'turn/completed') this.completeTurn(key, c, turn, turnError, failure, params);
    }
  }

  private trySave(key: string): boolean {
    try {
      this.save(key);
      return true;
    } catch {
      return false;
    }
  }

  private completeTurn(
    key: string,
    c: Conversation,
    turn: Record<string, unknown>,
    turnError: TurnError | undefined,
    failure: string,
    params: unknown,
  ): void {
    const status = str(turn.status);
    c.timing.usage = isRecord(turn.usage)
      ? (turn.usage as unknown as typeof c.timing.usage)
      : undefined;
    c.timing.log(this.diag.logger, key, status);
    if (status !== 'completed' && status !== 'interrupted') {
      const meta: Record<string, unknown> = { status };
      if (failure !== '' && turnError !== undefined) {
        const token = turnError.nixProviderError;
        Object.assign(meta, {
          operation: 'send',
          provider_error: token,
          http_status: token.slice(token.lastIndexOf('.') + 1),
        });
      }
      if (typeof turn.durationMs === 'number') meta.provider_duration_ms = turn.durationMs;
      Object.assign(meta, turnErrorAttrs(turnError));
      this.diag.record(key, 'warn', 'turn.failed', meta, { turn: traceRaw(params) });
    }
    this.cancelToolsLocked(key);
    if (turnError?.nixProviderError === 'nix.sharing_blocked') c.disclosureBlocked = true;
    c.messages = withoutDrafts(c.messages);
    c.turnId = '';
    if (c.disclosureBlocked) {
      c.state = 'error';
      c.reason = HISTORY_SHARING_RECOVERY;
    } else if (status === 'completed' && c.state !== 'error') {
      c.state = 'success';
    } else if (status === 'interrupted') {
      c.state = 'idle';
    } else {
      c.state = 'error';
      if (failure !== '') c.reason = failure;
      if (c.reason === '')
        c.reason =
          'The model could not finish the response. Check account access and usage, then retry.';
    }
    if (!this.trySave(key)) {
      c.state = 'error';
      c.reason = 'Conversation could not be saved.';
      this.bump(c);
    }
  }

  private routeInline(
    run: InlineRun,
    method: string,
    itemType: string,
    delta: string,
    status: string,
    failure: string,
  ): void {
    if (method === 'item/agentMessage/delta') {
      if (delta !== '') run.deliver({ kind: 'delta', text: delta });
    } else if ((method === 'item/started' || method === 'item/completed') && isToolItem(itemType)) {
      run.deliver({ kind: 'refused' });
    } else if (method === 'turn/completed') {
      run.deliver({ kind: 'completed', status, failure });
    }
  }

  /** Turns one provider notification for conversation key into events; deltas are never recorded. */
  private recordNotification(
    key: string,
    method: string,
    raw: unknown,
    itemType: string,
    phase: string,
    text: string,
    providerError: TurnError | undefined,
    willRetry: boolean,
  ): void {
    if (
      method === 'item/agentMessage/delta' ||
      method === 'item/reasoning/textDelta' ||
      method === 'item/reasoning/summaryTextDelta'
    )
      return;
    if (method === 'error') {
      this.diag.record(
        key,
        'warn',
        'provider.error',
        { will_retry: willRetry, ...turnErrorAttrs(providerError) },
        { params: traceRaw(raw) },
      );
    } else if (method === 'model/rerouted') {
      this.diag.record(key, 'warn', 'provider.model_rerouted', {}, { params: traceRaw(raw) });
    } else if (method === 'thread/compacted') {
      this.diag.record(key, 'info', 'provider.thread_compacted');
    } else if (method === 'item/completed' && itemType === 'agentMessage') {
      this.diag.record(
        key,
        'debug',
        'message',
        { phase: phase === '' ? 'final' : phase, chars: byteLen(text) },
        { text },
      );
    } else if (this.diag.trace) {
      // Everything else is kept only in the trace, raw, for reconstructing what the provider did.
      this.diag.record(
        key,
        'debug',
        'provider.notification',
        { method, item_type: itemType },
        { params: traceRaw(raw) },
      );
    }
  }

  // ---- tools ----

  private reply(id: unknown, result: unknown): boolean {
    if (this.transport.reply === undefined) return false;
    try {
      this.transport.reply(id, result);
    } catch {
      // the provider process is gone; the turn will end on its own
    }
    return true;
  }

  private replyStored(actor: Request, id: unknown, result: unknown): boolean {
    void this.canDisclose(actor)
      .then((allowed) => {
        const current = this.conversations.get(conversationKey(actor));
        const active =
          current?.actor === actor &&
          current.requestId === actor.requestId &&
          current.state === 'thinking' &&
          !current.interruptRequested;
        this.reply(
          id,
          allowed && active
            ? result
            : toolOutput(false, 'Sharing consent changed. The stored result was not sent.', ''),
        );
      })
      .catch(() => {
        this.reply(
          id,
          toolOutput(
            false,
            'Sharing consent could not be confirmed. The stored result was not sent.',
            '',
          ),
        );
      });
    return true;
  }

  /**
   * A tool call from the provider. Returns whether the request was accepted (replied to now or
   * later); false makes the transport answer the provider with a refusal.
   */
  toolRequest(id: unknown, method: string, params: unknown, bytes: number): boolean {
    const p = isRecord(params) ? params : {};
    const threadId = str(p.threadId);
    // A tool call on an inline thread is never honoured: the stream is ended with inline.refused.
    const inlineRun = threadId === '' ? undefined : this.inline.get(threadId);
    if (inlineRun !== undefined) {
      inlineRun.deliver({ kind: 'refused' });
      return false;
    }
    const tool = str(p.tool);
    const callId = str(p.callId);
    if (
      method !== 'item/tool/call' ||
      bytes > 40000 ||
      tool === '' ||
      callId === '' ||
      byteLen(callId) > 200
    )
      return false;
    for (const [key, c] of this.conversations) {
      if (c.threadId !== threadId || c.state !== 'thinking') continue;
      if (
        c.actor.consentMode === 'plan' &&
        typeof p.planBatchSize === 'number' &&
        p.planBatchSize > 12
      )
        return false;
      // Only the typed tool names are accepted; nix_workspace and anything else is rejected here.
      if (!toolNamesChat().has(tool)) {
        this.diag.record(
          key,
          'warn',
          'tool.rejected',
          { tool: truncateUtf8(tool, 80), reason: 'not offered' },
          { arguments: traceRaw(p.arguments) },
        );
        return false;
      }
      const flattened = flattenConversationToolCall(c, tool, p.arguments);
      if (flattened.flat === undefined) {
        // The reason can quote a key the model invented, so the shared log gets a fixed code.
        this.diag.record(
          key,
          'warn',
          'tool.refused',
          { tool, stage: 'arguments', reason_code: argumentRefusalCode(flattened.reason) },
          { arguments: traceRaw(p.arguments), reason: flattened.reason },
        );
        return this.reply(
          id,
          toolOutput(false, `${flattened.reason} No action ran and no approval was requested.`, ''),
        );
      }
      const flat = flattened.flat;
      // No operation runs without workspace access: the no-consent boundary.
      if (!c.workspaceAccess) {
        this.diag.record(
          key,
          'warn',
          'tool.rejected',
          { tool, reason: 'workspace access is off for this message' },
          { arguments: traceRaw(p.arguments) },
        );
        return false;
      }
      const invalid = validateToolArguments(flat);
      if (invalid !== '') {
        this.diag.record(
          key,
          'warn',
          'tool.refused',
          { tool, stage: 'validation', reason: invalid },
          { arguments: traceRaw(p.arguments), flat },
        );
        return this.reply(
          id,
          toolOutput(false, `${invalid} No action ran and no approval was requested.`, ''),
        );
      }
      const scopeRefusal = conversationToolRefusal(c, flat);
      if (scopeRefusal !== '') return this.reply(id, toolOutput(false, scopeRefusal, ''));
      let refusal = noteScopeToolRefusal(c, flat);
      if (refusal === '' && c.lockedRead && toolOperation(flat) === 'remember') {
        // Protected text in the thread could otherwise leave its lock as a "fact" the owner never
        // approved; memory runs without a card, so it stops here instead.
        refusal =
          'This conversation has read protected content, so nothing from it is remembered. The owner can add the fact in Settings > Pets > Memory.';
      }
      if (refusal !== '') return this.reply(id, toolOutput(false, refusal, ''));
      const { fingerprint, readOnly } = toolIdentity(flat);
      let readMayBeStale = false;
      for (let i = c.tools.length - 1; i >= 0; i--) {
        const t = c.tools[i];
        if (t === undefined) continue;
        const previous = toolIdentity(t.arguments);
        if (t.id === callId || (fingerprint !== '' && previous.fingerprint === fingerprint)) {
          // The same provider ID must never be repurposed for a different action.
          if (fingerprint === '' || previous.fingerprint !== fingerprint) return false;
          if (t.id !== callId && readOnly && readMayBeStale && t.status === 'completed') continue;
          this.diag.record(key, 'info', 'tool.deduplicated', {
            tool,
            status: t.status,
            same_call: t.id === callId,
          });
          if (['pending', 'claimed', 'planned', 'adopted'].includes(t.status)) {
            const idKey = JSON.stringify(id);
            if (t.hasRpcId && JSON.stringify(t.rpcId) === idKey) return true;
            if (t.waiters.some((w) => JSON.stringify(w) === idKey)) return true;
            if (t.waiters.length >= 20) return false;
            t.waiters.push(id);
            if (
              t.status === 'planned' &&
              typeof p.planBatchId === 'string' &&
              p.planBatchId === t.planBatchId
            ) {
              t.planBatchSeen = (t.planBatchSeen ?? 1) + 1;
              this.trySave(key);
            }
            return true;
          }
          return this.replyStored(
            c.actor,
            id,
            toolOutput(t.status === 'completed', t.result, t.image),
          );
        }
        // A read after a write needs fresh data, not a cached pre-write result.
        if (!previous.readOnly) readMayBeStale = true;
      }
      if (c.tools.length >= MAX_TOOL_CALLS_PER_TURN) {
        this.diag.record(key, 'warn', 'tool.rejected', {
          tool,
          reason: '20 tool calls per turn reached',
        });
        return this.reply(
          id,
          toolOutput(
            false,
            'This turn reached its limit of 20 tool calls. No action ran for this request. Stop calling tools in this turn, report what completed and what remains unverified, and continue the remaining work in a later user turn. Do not repeat completed or uncertain writes.',
            '',
          ),
        );
      }
      const call = newTool({
        id: callId,
        arguments: flat,
        status: c.actor.consentMode === 'plan' ? 'planned' : 'pending',
        result: '',
        claimId: '',
      });
      if (call.status === 'planned') {
        call.planBatchId = typeof p.planBatchId === 'string' ? p.planBatchId : call.id;
        call.planBatchSize =
          typeof p.planBatchSize === 'number' &&
          Number.isInteger(p.planBatchSize) &&
          p.planBatchSize > 0 &&
          p.planBatchSize <= 20
            ? p.planBatchSize
            : 1;
      }
      call.rpcId = id;
      call.hasRpcId = true;
      call.pendingSince = Date.now();
      c.tools.push(call);
      c.timing.toolRecorded();
      if (call.status === 'planned') {
        // Core adopts the complete frozen batch before any executor can claim it.
      } else if (c.conversationItemId !== '') {
        call.status = 'claimed';
        call.claimId = c.requestId;
        call.claimedAt = Date.now();
        void this.executeDurableTool(key, c.actor, call.id, flat);
      } else if (this.mayRunReadOnServer(c, flat, readOnly)) {
        call.status = 'claimed';
        call.claimId = c.requestId;
        call.claimedAt = Date.now();
        c.timing.toolClaimed(call.pendingSince);
        this.diag.record(key, 'info', 'tool.claimed', {
          tool: toolOperation(flat),
          pending_ms: 0,
          runner: 'server',
        });
        void this.executeServerTool(key, c.actor, call.id, flat);
      }
      if (!this.trySave(key)) {
        c.tools.pop();
        this.diag.record(key, 'error', 'tool.rejected', {
          tool,
          reason: 'conversation could not be saved',
        });
        return false;
      }
      this.diag.record(
        key,
        'info',
        'tool.requested',
        { tool, arguments_bytes: byteLen(JSON.stringify(p.arguments ?? null)) },
        { arguments: traceRaw(p.arguments), flat: traceRaw(flat) },
      );
      return true;
    }
    return false;
  }

  /** An approved write: claims the pending call and runs it here with Core's write token. */
  private approveTool(key: string, r: Request): void {
    const c = this.conversations.get(key);
    const t = c?.tools.find((tool) => tool.id === r.toolId);
    if (this.serverTools?.mode !== 'all' || r.turnToken === '')
      throw new Error('server writes are off');
    if (c === undefined || t === undefined) throw new Error('unknown tool call');
    if (c.state !== 'thinking' || t.status !== 'pending') {
      this.diag.record(key, 'warn', 'tool.claim_refused', {
        tool: toolOperation(t.arguments),
        status: t.status,
        turn_state: c.state,
      });
      throw new Error('tool already claimed; do not execute again');
    }
    const args = r.editedArguments || t.arguments;
    const operation = toolOperation(args);
    // Core sized the token by the approved operation: that is the one call it may run.
    if (operation !== r.approvedOperation) throw new Error('approval does not match the call');
    if (
      r.editedArguments !== '' &&
      (r.automatic ||
        operation !== toolOperation(t.arguments) ||
        validateToolArguments(args) !== '' ||
        noteScopeToolRefusal(c, args) !== '')
    )
      throw new Error('edited request is not allowed');
    const parsed = workspaceToolSchema.parse(JSON.parse(args));
    if (APP_ONLY_OPERATIONS.has(parsed.operation) || READ_ONLY_OPERATIONS.has(parsed.operation))
      throw new Error('this operation is not approved on the server');
    if (r.automatic && !mayApplyUnasked(parsed, c.lockedRead)) {
      // Left pending: the app shows the card. lockedRead here is authoritative.
      this.diag.record(key, 'info', 'tool.approve_held', { tool: operation });
      return;
    }
    t.status = 'claimed';
    t.claimId = r.requestId;
    t.claimedAt = Date.now();
    c.timing.toolClaimed(t.pendingSince);
    this.diag.record(key, 'info', 'tool.claimed', { tool: operation, runner: 'server' });
    this.save(key);
    void this.executeApprovedTool(key, c.actor, t.id, args, r);
  }

  private async executeApprovedTool(
    key: string,
    actor: Request,
    toolId: string,
    args: string,
    r: Request,
  ): Promise<void> {
    const serverTools = this.serverTools;
    if (serverTools === undefined) return;
    const c0 = this.conversations.get(key);
    let text = '';
    let success = false;
    let lockedContent = false;
    try {
      const out = await serverTools.run(
        {
          // The write token lives in this closure only: never stored on the conversation or logged.
          token: r.turnToken,
          workspaceId: actor.workspaceId,
          args,
          timeZone: actor.timeZone,
          ...(c0 !== undefined && c0.rootItemId !== ''
            ? { scope: { rootItemId: c0.rootItemId, readOnly: c0.readOnly } }
            : {}),
          toolId,
          claimId: r.requestId,
          ...(r.fingerprint === '' ? {} : { fence: r.fingerprint }),
        },
        AbortSignal.timeout(SERVER_WRITE_MS),
        true,
      );
      if (out.kind === 'result') ({ text, success, lockedContent } = out);
    } catch {
      // the uncertain-result text below stands
    }
    if (text === '')
      text =
        'The operation failed or its result is uncertain. Inspect Nix before retrying a write. Do not assume success.';
    else if (r.editNote !== '') text = `${r.editNote}\n${text}`;
    const c = this.conversations.get(key);
    if (c?.requestId !== actor.requestId || c.state !== 'thinking') return;
    try {
      await this.resolveDisclosedTool(key, {
        ...emptyRequest(),
        operation: 'tool_result',
        requestId: r.requestId,
        toolId,
        toolResult: text,
        toolSuccess: success,
        toolLockedContent: lockedContent,
      });
    } catch {
      // the claim no longer matches; nothing to resolve
    }
  }

  private mayRunReadOnServer(c: Conversation, flat: string, readOnly: boolean): boolean {
    return (
      this.serverTools !== undefined &&
      readOnly &&
      !APP_ONLY_OPERATIONS.has(toolOperation(flat) as WorkspaceToolArgs['operation']) &&
      c.actor.readWithoutAsking &&
      c.actor.turnToken !== ''
    );
  }

  /** Runs a read with the turn token and feeds the result back; the app gets it when it must. */
  private async executeServerTool(
    key: string,
    actor: Request,
    toolId: string,
    args: string,
  ): Promise<void> {
    const serverTools = this.serverTools;
    if (serverTools === undefined) return;
    const c0 = this.conversations.get(key);
    const outcome = await serverTools
      .run(
        {
          token: actor.turnToken,
          workspaceId: actor.workspaceId,
          args,
          timeZone: actor.timeZone,
          ...(c0 !== undefined && c0.rootItemId !== ''
            ? { scope: { rootItemId: c0.rootItemId, readOnly: c0.readOnly } }
            : {}),
          toolId,
          claimId: actor.requestId,
        },
        AbortSignal.timeout(SERVER_READ_MS),
      )
      .catch(() => ({ kind: 'app' as const }));
    const c = this.conversations.get(key);
    // Core refused the token: later reads of the turn go to the app, not into more 401s.
    if (outcome.kind === 'app' && 'stopToken' in outcome && c?.requestId === actor.requestId)
      c.actor.turnToken = '';
    if (c?.requestId !== actor.requestId || c.state !== 'thinking') return;
    if (outcome.kind === 'app') {
      const t = c.tools.find((tool) => tool.id === toolId);
      if (t?.status !== 'claimed' || t.claimId !== actor.requestId) return;
      t.status = 'pending';
      t.claimId = '';
      t.claimedAt = 0;
      this.diag.record(key, 'info', 'tool.released', { tool: toolOperation(args), reason: 'app' });
      this.trySave(key);
      return;
    }
    try {
      await this.resolveDisclosedTool(key, {
        ...emptyRequest(),
        operation: 'tool_result',
        requestId: actor.requestId,
        toolId,
        toolResult: outcome.text,
        toolSuccess: outcome.success,
        toolLockedContent: outcome.lockedContent,
        toolImage: outcome.image,
      });
    } catch {
      // the claim no longer matches; nothing to resolve
    }
  }

  /** Runs a saved conversation's tool in Core and feeds the result back, off the request path. */
  private async executeDurableTool(
    key: string,
    actor: Request,
    toolId: string,
    args: string,
  ): Promise<void> {
    let result = 'The source could not be read. Treat this analysis as incomplete.';
    let success = false;
    let locked = false;
    if (this.executeConversationTool !== undefined) {
      try {
        const out = await this.executeConversationTool(
          AbortSignal.timeout(30_000),
          actor.conversationItemId,
          actor.tenantId,
          actor.principalId,
          actor.requestId,
          args,
        );
        ({ text: result, success, lockedContent: locked } = out);
      } catch {
        // the fixed incomplete-analysis result stands
      }
    }
    const c = this.conversations.get(key);
    if (c?.requestId !== actor.requestId || c.state !== 'thinking') return;
    try {
      await this.resolveDisclosedTool(key, {
        ...emptyRequest(),
        operation: 'tool_result',
        requestId: actor.requestId,
        toolId,
        toolResult: result,
        toolSuccess: success,
        toolLockedContent: locked,
      });
    } catch {
      // the claim no longer matches; nothing to resolve
    }
  }

  async handlePlanTools(r: Request): Promise<unknown> {
    const key = conversationKey(r);
    this.load(key);
    const c = this.conversations.get(key);
    if (
      c?.requestId !== r.requestId ||
      c.actor.tenantId !== r.tenantId ||
      c.actor.principalId !== r.principalId ||
      c.actor.workspaceId !== r.workspaceId ||
      c.actor.petId !== r.petId ||
      c.actor.consentMode !== 'plan'
    )
      throw new Error('The planned turn is not active.');
    const payload: unknown = JSON.parse(r.planPayload);
    if (r.operation === 'plan_tools_inspect') {
      const { toolIds } = inspectPlanToolsSchema.parse(payload);
      const sourceScope =
        this.sourceScopes.get(c.requestId) ??
        (c.providerContext?.turnId === c.requestId ? c.providerContext.sourceScope : undefined);
      if (sourceScope === undefined)
        throw new Error('The original source scope is unavailable. Start a new conversation.');
      const context = c.providerContext?.turnId === c.requestId ? c.providerContext : undefined;
      const batch = this.snapshot(key).plannedBatch;
      if (
        batch !== undefined &&
        (!batch.ready ||
          batch.toolIds.length !== toolIds.length ||
          batch.toolIds.some((id) => !toolIds.includes(id)))
      )
        throw new Error('The complete tool batch must be reviewed together.');
      if (new Set(toolIds).size !== toolIds.length) throw new Error('Duplicate planned call.');
      const tools = toolIds.map((id) => {
        const tool = c.tools.find((entry) => entry.id === id);
        if (tool === undefined || !['planned', 'adopted'].includes(tool.status))
          throw new Error('The planned call is unavailable.');
        return publicTool(tool);
      });
      return {
        turnId: c.requestId,
        sourceScope,
        contextSourceItemIds: context?.sourceItemIds ?? [],
        contextProtected: c.lockedRead || (context?.protectedRead ?? false),
        contextUnbounded: context?.unbounded ?? true,
        timeZone: c.actor.timeZone,
        today: c.actor.today,
        buildReceipts: c.tools
          .filter(
            (tool) =>
              tool.status === 'completed' &&
              tool.planBinding !== undefined &&
              toolOperation(tool.arguments) === 'build_blueprint',
          )
          .map((tool) => ({ binding: tool.planBinding, result: tool.result })),
        tools,
        lockedRead: c.lockedRead,
        rootItemId: c.rootItemId,
        readOnly: c.readOnly,
        readWithoutAsking: c.actor.readWithoutAsking,
      };
    }
    if (r.operation === 'plan_tools_cancel') {
      const { toolIds, runId } = cancelPlanToolsSchema.parse(payload);
      if (new Set(toolIds).size !== toolIds.length) throw new Error('Duplicate planned call.');
      const current = c.tools.filter((tool) => tool.status === 'planned');
      if (current.some((tool) => !toolIds.includes(tool.id)))
        throw new Error('Cancel the complete planned batch.');
      const reason =
        'The owner stopped the plan. Check its receipts for any changes that already started.';
      const tools = toolIds.map((id) => {
        const tool = c.tools.find((entry) => entry.id === id);
        if (
          tool === undefined ||
          (tool.planBinding !== undefined && tool.planBinding.runId !== runId) ||
          (!['planned', 'adopted'].includes(tool.status) &&
            !(tool.status === 'failed' && tool.result === reason))
        )
          throw new Error('The planned call belongs to a different run or has already settled.');
        return tool;
      });
      for (const tool of tools) {
        tool.status = 'failed';
        tool.result = reason;
      }
      c.state = 'idle';
      this.save(key);
      if (c.turnId !== '')
        await this.transport.call(
          'turn/interrupt',
          { threadId: c.threadId, turnId: c.turnId },
          AbortSignal.timeout(5000),
        );
      return { cancelled: true };
    }
    if (r.operation === 'plan_tools_adopt') {
      const { bindings } = adoptPlanToolsSchema.parse(payload);
      if (new Set(bindings.map((binding) => binding.toolId)).size !== bindings.length)
        throw new Error('Duplicate planned call.');
      const entries = bindings.map((binding) => {
        const tool = c.tools.find((entry) => entry.id === binding.toolId);
        if (
          tool === undefined ||
          !['planned', 'adopted'].includes(tool.status) ||
          (tool.planBinding !== undefined &&
            JSON.stringify(tool.planBinding) !== JSON.stringify(binding))
        )
          throw new Error('The planned call is already owned or unavailable.');
        return { tool, binding };
      });
      for (const { tool, binding } of entries) {
        tool.status = 'adopted';
        tool.planBinding = binding;
      }
      this.save(key);
      return { adopted: true };
    }
    if (r.operation === 'plan_tools_supersede') {
      const { bindings } = supersedePlanToolsSchema.parse(payload);
      if (new Set(bindings.map((entry) => entry.next.toolId)).size !== bindings.length)
        throw new Error('Duplicate planned call.');
      const entries = bindings.map(({ previous, next }) => {
        const tool = c.tools.find((entry) => entry.id === previous.toolId);
        if (
          tool?.status !== 'adopted' ||
          tool.planBinding === undefined ||
          previous.toolId !== next.toolId ||
          previous.runId !== next.runId ||
          previous.planId !== next.planId ||
          next.planVersion !== previous.planVersion + 1 ||
          (JSON.stringify(tool.planBinding) !== JSON.stringify(previous) &&
            JSON.stringify(tool.planBinding) !== JSON.stringify(next))
        )
          throw new Error('The previous plan association changed or cannot be superseded.');
        return { tool, next };
      });
      for (const { tool, next } of entries) tool.planBinding = next;
      this.save(key);
      return { superseded: true };
    }
    const value = resolvePlanToolSchema.parse(payload);
    const tool = c.tools.find((entry) => entry.id === value.binding.toolId);
    if (
      tool?.planBinding === undefined ||
      JSON.stringify(tool.planBinding) !== JSON.stringify(value.binding)
    )
      throw new Error('The plan receipt does not match the adopted call.');
    if (tool.status === 'completed' || tool.status === 'failed') {
      if (tool.result !== value.result || (tool.status === 'completed') !== value.success)
        throw new Error('The plan receipt changed.');
      return { resolved: true };
    }
    if (c.disclosureBlocked && tool.status === 'interrupted') {
      tool.status = value.success ? 'completed' : 'failed';
      tool.result = value.result;
      if (value.lockedContent) c.lockedRead = true;
      this.save(key);
      return { resolved: true };
    }
    if (tool.status !== 'adopted' || !tool.hasRpcId)
      throw new Error('The provider call is no longer waiting.');
    if (c.providerContext !== undefined)
      addContextSources(
        c.providerContext,
        value.sourceItemIds ?? [],
        value.lockedContent,
        value.unboundedSourceProvenance ?? value.sourceItemIds === undefined,
      );
    const originalActor = c.actor;
    const allowed = await this.canDisclose(originalActor);
    const active = c.tools.find((entry) => entry.id === value.binding.toolId);
    if (
      c.requestId !== r.requestId ||
      active !== tool ||
      JSON.stringify(active.planBinding) !== JSON.stringify(value.binding)
    )
      throw new Error('The plan changed while disclosure was being confirmed.');
    if (active.status === 'completed' || active.status === 'failed') {
      if (active.result === value.result && (active.status === 'completed') === value.success)
        return { resolved: true };
      throw new Error('The plan receipt changed while disclosure was being confirmed.');
    }
    if (active.status !== 'adopted') throw new Error('The planned call is no longer active.');
    const current = this.conversations.get(key);
    if (
      current !== c ||
      c.actor !== originalActor ||
      c.state !== 'thinking' ||
      c.interruptRequested
    ) {
      tool.status = value.success ? 'completed' : 'failed';
      tool.result = value.result;
      if (value.lockedContent) c.lockedRead = true;
      tool.waiters = [];
      if (current === c) this.save(key);
      return { resolved: true };
    }
    if (!allowed) {
      tool.status = value.success ? 'completed' : 'failed';
      tool.result = value.result;
      if (value.lockedContent) c.lockedRead = true;
      c.disclosureBlocked = true;
      c.state = 'error';
      c.reason = HISTORY_SHARING_RECOVERY;
      for (const waiting of c.tools) {
        if (waiting.status === 'planned' || waiting.status === 'adopted') {
          waiting.status = 'interrupted';
          waiting.result =
            'The provider turn stopped before this result was forwarded. Check execution receipts in Nix before retrying.';
        }
        waiting.waiters = [];
      }
      this.save(key);
      await this.transport
        .call(
          'turn/interrupt',
          { threadId: c.threadId, turnId: c.turnId },
          AbortSignal.timeout(5000),
        )
        .catch(() => undefined);
      return { resolved: true };
    }
    tool.status = value.success ? 'completed' : 'failed';
    tool.result = value.result;
    if (value.lockedContent) c.lockedRead = true;
    this.save(key);
    for (const id of [tool.rpcId, ...tool.waiters])
      this.reply(id, toolOutput(value.success, value.result, ''));
    tool.waiters = [];
    return { resolved: true };
  }

  private async resolveDisclosedTool(key: string, r: Request): Promise<void> {
    const c = this.conversations.get(key);
    if (r.operation === 'tool_result' && c !== undefined && !(await this.canDisclose(c.actor)))
      throw new Error('Sharing consent changed. The result was not sent to the provider.');
    this.resolveTool(key, r);
  }

  resolveTool(key: string, r: Request): void {
    const c = this.conversations.get(key);
    if (c === undefined) throw new Error('unknown tool call');
    const t = c.tools.find((tool) => tool.id === r.toolId);
    if (t === undefined) throw new Error('unknown tool call');
    if (['planned', 'adopted'].includes(t.status) || t.planBinding !== undefined)
      throw new Error('This tool belongs to a reviewed plan. Use the exact plan decision.');
    if (r.operation === 'tool_claim') {
      if (c.state !== 'thinking' || t.status !== 'pending') {
        this.diag.record(key, 'warn', 'tool.claim_refused', {
          tool: toolOperation(t.arguments),
          status: t.status,
          turn_state: c.state,
        });
        throw new Error('tool already claimed; do not execute again');
      }
      t.status = 'claimed';
      c.timing.toolClaimed(t.pendingSince);
      this.diag.record(key, 'info', 'tool.claimed', {
        tool: toolOperation(t.arguments),
        pending_ms: t.pendingSince === 0 ? 0 : Date.now() - t.pendingSince,
      });
      t.claimedAt = Date.now();
      t.claimId = r.requestId;
      this.save(key);
      return;
    }
    if (t.claimId !== r.requestId) throw new Error('tool claim does not match');
    if (t.status === 'completed' || t.status === 'failed') return;
    if (t.status !== 'claimed' || !t.hasRpcId) throw new Error('tool is no longer active');
    if (this.transport.reply === undefined) throw new Error('tool transport unavailable');
    t.result = r.toolResult.trim();
    t.image = r.toolImage;
    if (t.result === '') t.result = 'No result supplied. Do not assume the operation succeeded.';
    t.status = r.toolSuccess ? 'completed' : 'failed';
    if (c.providerContext !== undefined)
      addContextSources(c.providerContext, [], r.toolLockedContent, true);
    // Sticky for the thread's life: the result is now in the model's context.
    if (r.toolLockedContent) c.lockedRead = true;
    const kind = resultKind(r.toolSuccess, t.result);
    const rawSyntax = rawSyntaxKinds(t.result);
    this.diag.record(
      key,
      kind === 'failed' || kind === 'no_result' ? 'warn' : 'info',
      'tool.result',
      {
        tool: toolOperation(t.arguments),
        outcome: kind,
        run_ms: t.claimedAt === 0 ? 0 : Date.now() - t.claimedAt,
        result_chars: byteLen(t.result),
        ...(rawSyntax === '' ? {} : { raw_syntax: rawSyntax }),
      },
      { result: t.result },
    );
    this.save(key);
    let replyError: unknown;
    for (const id of [t.rpcId, ...t.waiters]) {
      try {
        this.transport.reply(id, toolOutput(r.toolSuccess, t.result, t.image));
      } catch (error) {
        replyError = error;
      }
    }
    t.waiters = [];
    if (replyError !== undefined)
      throw replyError instanceof Error ? replyError : new Error('reply failed');
  }

  cancelTools(key: string): void {
    this.cancelToolsLocked(key);
    this.trySave(key);
  }

  cancelToolsLocked(key: string): void {
    const c = this.conversations.get(key);
    if (c === undefined) return;
    c.interruptRequested = true;
    c.actor.turnToken = ''; // the token lives no longer than its turn
    for (const t of c.tools) {
      if (t.status === 'planned') {
        t.status = 'interrupted';
        t.result = 'The owner stopped this planned turn. No plan decision was made.';
        t.waiters = [];
        continue;
      }
      if (t.status !== 'pending' && t.status !== 'claimed') continue;
      this.diag.record(key, 'warn', 'tool.interrupted', {
        tool: toolOperation(t.arguments),
        status: t.status,
      });
      t.result =
        'The turn ended before this request was confirmed. A claimed write may have completed; inspect Nix before retrying.';
      for (const id of [t.rpcId, ...t.waiters]) {
        if (t.hasRpcId || id !== t.rpcId) this.reply(id, toolOutput(false, t.result, ''));
      }
      t.waiters = [];
      t.status = 'interrupted';
    }
  }

  // ---- history ----

  private historyDir(key: string): string {
    return join(this.home, `${key}-history`);
  }

  /** Archives the live conversation (when it has messages) as a new history entry. */
  archive(key: string): void {
    const c = this.conversations.get(key);
    if (c === undefined || c.messages.length === 0) return;
    const dir = this.historyDir(key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (readdirSync(dir).length >= MAX_HISTORY_ENTRIES) {
      throw new Error(
        'conversation history is full; export and remove an archived conversation first',
      );
    }
    writeArchive(dir, c);
  }

  /**
   * Moves what the retired Design conversation left on disk for key (its live conversation and
   * archived threads, kept under key+"-consult") into key's own history, where it stays readable
   * but takes no new messages. A no-op once nothing is left.
   */
  private foldDesign(key: string): void {
    const old = `${key}-consult`;
    const livePath = join(this.home, `${old}.json`);
    const oldHistory = join(this.home, `${old}-history`);
    const has = (path: string): boolean => {
      try {
        statSync(path);
        return true;
      } catch {
        return false;
      }
    };
    const live = has(livePath);
    const history = has(oldHistory);
    if (!live && !history) return;
    const target = this.historyDir(key);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    if (live) {
      let raw: unknown;
      try {
        raw = readJsonFile(livePath);
      } catch {
        throw new Error('design conversation could not be restored');
      }
      const c = newConversation();
      if (isRecord(raw)) {
        c.messages = messages(raw.messages);
        c.tools = toolCalls(raw.tools).map(newTool);
        c.title = str(raw.title);
        c.lockedRead = raw.lockedRead === true;
      }
      if (c.messages.length > 0) writeArchive(target, c);
      rmSync(livePath, { force: true });
    }
    if (history) {
      for (const entry of readdirSync(oldHistory, { withFileTypes: true })) {
        const id = entry.name.replace(/\.json$/, '');
        if (entry.isDirectory() || !UUID.test(id)) continue;
        renameSync(join(oldHistory, entry.name), join(target, entry.name));
      }
      rmSync(oldHistory, { recursive: true, force: true });
    }
    this.diag.removeTrace(old);
  }

  /**
   * Swaps the archive r.historyId in as key's live conversation. The live one (when it has
   * messages) is archived in its place, so the archive count never changes and the cap cannot
   * refuse a resume. The archive has no provider thread and no approval cards; the next send
   * starts a fresh thread seeded with the visible messages. A legacy archive without a recorded
   * hold resumes held, since its transcript may quote protected content.
   */
  private resume(key: string, r: Request): void {
    const dir = this.historyDir(key);
    const path = join(dir, `${r.historyId}.json`);
    const old = this.conversations.get(key);
    if (old === undefined) return;
    if (old.state === 'thinking') throw new Error('stop the running turn first');
    const value = readArchive(path);
    if (old.messages.length > 0) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeArchive(dir, old);
    }
    const resumed = newConversation();
    resumed.messages = value.messages;
    resumed.title = value.title;
    resumed.rootItemId = r.rootItemId;
    resumed.lockedRead = value.lockedRead === undefined || value.lockedRead;
    resumed.providerContext = value.providerContext;
    resumed.revision = old.revision;
    this.conversations.set(key, resumed);
    this.save(key);
    // Removed only after the live save: a crash between the two leaves a duplicate, not a loss.
    rmSync(path);
    this.diag.removeTrace(key);
  }

  private renameLive(key: string, r: Request): void {
    const c = this.conversations.get(key);
    if (c === undefined) return;
    if (c.state === 'thinking') throw new Error('stop the running turn first');
    c.title = r.text.trim();
    this.save(key);
  }

  private async history(key: string, r: Request): Promise<Response> {
    const dir = this.historyDir(key);
    const result = this.snapshot('');
    if (r.operation === 'rename') {
      if (!UUID.test(r.historyId)) throw new Error('invalid history identity');
      const value = readArchive(join(dir, `${r.historyId}.json`));
      value.title = r.text.trim();
      // The file's own id names the write target; keep it to the validated one.
      value.id = r.historyId;
      writeArchiveFile(dir, value);
    }
    if (r.operation === 'read_history' || r.operation === 'delete_history') {
      if (!UUID.test(r.historyId)) throw new Error('invalid history identity');
      const path = join(dir, `${r.historyId}.json`);
      if (r.operation === 'delete_history') {
        rmSync(path, { force: true });
        // A trace holds this conversation's full content too; deleting history must not leave it.
        this.diag.removeTrace(key);
      } else {
        const value = readArchive(path);
        result.messages = value.messages;
        result.tools = value.tools;
        return result;
      }
    }
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw error;
    }
    // Reads are async and bounded so a populated history does not stall the shared event loop.
    // Results keep directory order, and one corrupt entry still fails the whole listing.
    const names = entries.filter((name) => UUID.test(name.replace(/\.json$/, '')));
    const archives: HistoryArchive[] = new Array<HistoryArchive>(names.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < names.length) {
        const i = next++;
        archives[i] = await readArchiveAsync(join(dir, names[i] ?? ''));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(HISTORY_READ_CONCURRENCY, names.length) }, worker),
    );
    for (const value of archives) {
      result.history.push({ id: value.id, title: value.title, createdAt: value.createdAt });
    }
    result.history.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
    // Sorted before the cap, so a folded history over 32 entries shows its newest.
    result.history = result.history.slice(0, MAX_HISTORY_ENTRIES);
    return result;
  }
}

function publicModel(m: ModelInfo): Model {
  return { id: m.id, name: m.name, default: m.default, supportsTools: m.supportsTools };
}

function turnErrorOf(value: unknown): TurnError | undefined {
  if (!isRecord(value)) return undefined;
  return {
    message: str(value.message),
    nixProviderError: str(value.nixProviderError),
    codexErrorInfo: value.codexErrorInfo,
  };
}

/** The tool result the provider reads back: text, plus a picture when the result carried one. */
export function toolOutput(success: boolean, result: string, image: string): unknown {
  const items: unknown[] = [{ type: 'inputText', text: result }];
  if (image !== '') items.push({ type: 'inputImage', imageUrl: image });
  return { success, contentItems: items };
}

/** tmp + fsync + rename, mode 0600: a crash leaves the old file or the new one, never half. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function writeArchive(dir: string, c: Conversation): void {
  writeArchiveFile(dir, {
    id: randomUUID(),
    title: c.title === '' ? defaultTitle(c.messages) : c.title,
    createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    messages: c.messages,
    tools: c.tools.map(publicTool),
    lockedRead: c.lockedRead,
    ...(c.providerContext === undefined ? {} : { providerContext: c.providerContext }),
  });
}

function writeArchiveFile(dir: string, value: HistoryArchive): void {
  const tmp = join(dir, `.archive-${randomUUID()}`);
  try {
    writeFileAtomic(tmp, `${JSON.stringify(value)}\n`);
    renameSync(tmp, join(dir, `${value.id}.json`));
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}.tmp`, { force: true });
  }
}

function readArchive(path: string): HistoryArchive {
  let raw: unknown;
  try {
    raw = readJsonFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error('history could not be loaded');
  }
  return parseArchive(raw);
}

async function readArchiveAsync(path: string): Promise<HistoryArchive> {
  let raw: unknown;
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('too large');
    raw = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error('history could not be loaded');
  }
  return parseArchive(raw);
}

function parseArchive(raw: unknown): HistoryArchive {
  if (!isRecord(raw)) throw new Error('history could not be loaded');
  return {
    id: str(raw.id),
    title: str(raw.title),
    createdAt: str(raw.createdAt),
    messages: messages(raw.messages),
    tools: toolCalls(raw.tools),
    lockedRead: typeof raw.lockedRead === 'boolean' ? raw.lockedRead : undefined,
    providerContext: readProviderContext(raw.providerContext),
  };
}
