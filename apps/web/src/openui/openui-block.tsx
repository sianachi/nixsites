import {
  BuiltinActionType,
  createParser,
  mergeStatements,
  Renderer,
  type ActionEvent,
  type ParseResult,
} from '@openuidev/react-lang';
import { Button, Text, focusRing } from '@nix/ui';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import type { NixClient } from '@nix/api-client';

import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { ApprovalCard, type WriteDecision } from '../pets/approval/approval-card';
import { afterWrite } from '../pets/approval/prepare-write';
import { storableState, type ProgramPiece } from './fence';
import { nixLibrary, OpenUiScope } from './library';
import { SaveArtifact } from './save-artifact';
import {
  createMutationTools,
  createQueryTools,
  MUTATION_TOOLS,
  QUERY_TOOLS,
  type WriteRequest,
} from './tool-provider';

/** The executor's ports for this client, loaded with the companion chunk on first use. */
async function companion(client: NixClient) {
  const module = await import('@nix/companion');
  const ports = {
    core: client,
    collab: client,
    bodies: module.createCompanionBodies(client),
    clock: module.defaultClock(),
    ids: module.defaultIds(),
  };
  return { run: module.runWorkspaceTool, ports };
}

const parser = createParser(nixLibrary.toJSONSchema());
const READS: ReadonlySet<string> = new Set(QUERY_TOOLS);
const WRITES: ReadonlySet<string> = new Set(MUTATION_TOOLS);

function literal(node: unknown, allowed: ReadonlySet<string>): boolean {
  const ast = node as { k?: unknown; v?: unknown } | null;
  return ast?.k === 'Str' && typeof ast.v === 'string' && allowed.has(ast.v);
}

/** Whether a program may be handed write tools at all. The renderer resolves Query() and
 * Mutation() through one tool map, and a Query runs on render, on every change of its arguments
 * and on a timer - so a Query naming a write tool would ask for writes with no click, over and
 * over. Every Query must name a read and every Mutation a write, both as literal strings. */
function writesAllowed(program: string): boolean {
  const result = parser.parse(program);
  return (
    result.queryStatements.every((query) => literal(query.toolAST, READS)) &&
    result.mutationStatements.every((mutation) => literal(mutation.toolAST, WRITES))
  );
}

/** The longest message a component may put in the composer; a longer one is cut. */
const ASK_LIMIT = 500;

/** Keys pending writes across every block; only ever compared, never shown. */
let writeIds = 0;

/** The program a run of blocks adds up to: each whole program replaces the last, each patch
 * changes it. Null while there is nothing to patch (the earlier program is out of view). */
function fold(pieces: readonly ProgramPiece[]): string | null {
  let program: string | null = null;
  for (const piece of pieces) {
    if (!piece.patch) program = piece.source;
    else if (program !== null) program = mergeStatements(program, piece.source);
  }
  return program;
}

interface PendingWrite {
  readonly id: number;
  readonly request: WriteRequest;
  readonly settle: (decision: WriteDecision) => void;
}

const STORAGE_PREFIX = 'nix.openui.state.';

// shortcut: a chat block's state lives in this browser only (per device, per viewer); move it to
// Core per user if owners ask for their chat tools to follow them across devices.
function storedState(key: string | undefined): Record<string, unknown> | undefined {
  if (key === undefined) return undefined;
  try {
    const text = localStorage.getItem(STORAGE_PREFIX + key);
    return text === null ? undefined : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function storeState(key: string, state: Record<string, unknown>): void {
  const text = storableState(state);
  try {
    if (text !== null) localStorage.setItem(STORAGE_PREFIX + key, text);
  } catch {
    // Storage can be full or blocked; the block keeps working with in-memory state.
  }
}

/** A same-workspace item path, the only place a block's OpenUrl may go. */
function itemPath(url: unknown, workspaceIds: readonly string[]): string | null {
  const match =
    typeof url === 'string' ? /^\/w\/([a-f0-9-]{36})\/?\?item=[a-f0-9-]{36}$/.exec(url) : null;
  return match && workspaceIds.includes(match[1] ?? '') ? (url as string) : null;
}

export interface OpenUiBlockProps {
  /** The `openui-lang` program, possibly still streaming in. */
  readonly source: string;
  /** Where queries may read and links may go; the first is the default workspace. */
  readonly workspaceIds: readonly string[];
  readonly streaming?: boolean;
  /** Sends a follow-up message to the pet; absent where there is no conversation. */
  readonly onAsk?: ((message: string) => void) | undefined;
  /** Shown when the program cannot render at all: the source as a code block. */
  readonly fallback: ReactNode;
  /** A chat block's identity (message id and block index); its state is kept per viewer. */
  readonly stateKey?: string | undefined;
  /** State to start from, for an artifact whose state is stored with the item. */
  readonly initialState?: Record<string, unknown> | undefined;
  /** Called with the whole state map after every change, for an artifact to store. */
  readonly onStateChange?: ((state: Record<string, unknown>) => void) | undefined;
  /** Offers "Save as artifact" under the block. */
  readonly saveable?: boolean;
  /** The conversation's "Apply without asking" switch; anywhere else every write asks. */
  readonly applyWithoutAsking?: boolean;
  /** Reads only, for a block drawn inside an approval card: it can never ask for a write. */
  readonly readOnly?: boolean;
  /** For a patch block: the blocks before it in the conversation, which it changes. */
  readonly base?: readonly ProgramPiece[] | undefined;
  /** The conversation already read locked content: every write waits for the owner. */
  readonly followsLockedRead?: boolean;
  /** A note-scoped conversation's scope, which bounds this block's reads and writes too. */
  readonly noteScope?: { readonly rootItemId: string; readonly readOnly: boolean } | undefined;
}

/**
 * Renders a model-written program with the Nix library only. The model cannot reach HTML, script
 * or a component this app did not register; its data comes through read-only queries in the
 * viewer's session, and its actions are filtered here: local state steps run inside the
 * renderer, a same-workspace item link navigates, "ask" goes to the pet, and anything else is
 * dropped.
 */
export default function OpenUiBlock({
  source,
  workspaceIds,
  streaming = false,
  onAsk,
  fallback,
  stateKey,
  initialState,
  onStateChange,
  saveable = false,
  applyWithoutAsking = false,
  readOnly: readOnlyBlock = false,
  base,
  followsLockedRead = false,
  noteScope,
}: OpenUiBlockProps): ReactNode {
  // A patch draws the program it changes, as changed; `program` is what renders and saves.
  const earlier = useMemo(() => (base === undefined ? null : fold(base)), [base]);
  const program =
    base === undefined ? source : earlier === null ? null : mergeStatements(earlier, source);
  const safe = useMemo(() => program !== null && writesAllowed(program), [program]);
  // A read-only note offers no writes at all, and neither does a program that misuses Query.
  const readOnly = readOnlyBlock || (noteScope?.readOnly ?? false) || !safe;
  const scopeRoot = noteScope?.rootItemId;
  const scopeReadOnly = noteScope?.readOnly ?? true;
  // Optional so a block still renders where no client is mounted; its queries then fail.
  const client = useOptionalApiClient();
  const navigate = useNavigate();
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [startState] = useState(() => initialState ?? storedState(stateKey));
  const state = useRef<Record<string, unknown>>(startState ?? {});
  const block = useRef<HTMLDivElement | null>(null);
  // The state to save, captured when "Save as artifact" is pressed; null while not saving.
  const [saving, setSaving] = useState<{ readonly state: string | null } | null>(null);
  // Writes wait here, one card at a time, until the owner decides.
  const [writes, setWrites] = useState<readonly PendingWrite[]>([]);
  // Once any query in this block reads locked content, its writes always wait for the owner, as
  // the pet's do after a locked read.
  const [held, setHeld] = useState(false);
  const scopeKey = workspaceIds.join(',');
  const tools = useMemo(() => {
    if (client === null) return null;
    const scope = scopeKey.split(',');
    // shortcut: calls are not cancelled on unmount (the renderer drops late results); add an
    // abort if long reads such as large views start to pile up.
    const signal = new AbortController().signal;
    const note =
      scopeRoot === undefined ? undefined : { rootItemId: scopeRoot, readOnly: scopeReadOnly };
    const reads = createQueryTools(scope, async (workspaceId, raw) => {
      const { run, ports } = await companion(client);
      const outcome = await run(ports, workspaceId, raw, signal, note ? { scope: note } : {});
      if (outcome.lockedContent) setHeld(true);
      return outcome;
    });
    if (readOnly) return reads;
    const writes = createMutationTools(
      scope,
      (request) =>
        new Promise<WriteDecision>((settle) => {
          const id = (writeIds += 1);
          // One change waits at a time: a further request while one is open is refused, so a
          // program cannot queue a stream of cards.
          setWrites((pending) => {
            if (pending.length === 0) return [{ id, request, settle }];
            settle({ approved: false });
            return pending;
          });
        }),
      async (workspaceId, args, fence) => {
        const { run, ports } = await companion(client);
        const outcome = await run(ports, workspaceId, JSON.stringify(args), signal, {
          fence,
          ...(note ? { scope: note } : {}),
        });
        afterWrite(client, workspaceId, args, outcome);
        return outcome;
      },
    );
    return { ...reads, ...writes };
  }, [client, scopeKey, readOnly, scopeRoot, scopeReadOnly]);
  const pendingWrite = writes[0];

  function act(event: ActionEvent) {
    if (event.type === BuiltinActionType.OpenUrl) {
      const path = itemPath(event.params.url, workspaceIds);
      if (path) void navigate(path);
    } else if (event.type === BuiltinActionType.ContinueConversation) {
      // Bounded: a message is an expression, so it could carry what a query read.
      const message = event.humanFriendlyMessage.trim().slice(0, ASK_LIMIT);
      if (message) onAsk?.(message);
    }
  }

  if (program === null)
    return (
      <div className="flex flex-col gap-1">
        <Text variant="note" tone="muted">
          This changes a component that is no longer in this conversation.
        </Text>
        {fallback}
      </div>
    );
  if (!streaming && parsed !== null && parsed.root === null) return fallback;
  return (
    <OpenUiScope.Provider value={workspaceIds}>
      <div
        ref={block}
        // Focusable by script only: after a decision the card is gone and focus lands here.
        tabIndex={-1}
        className={`min-w-0 rounded-md border border-divider p-3 focus:outline-none ${focusRing}`}
        data-openui-block=""
      >
        <Renderer
          response={program}
          library={nixLibrary}
          isStreaming={streaming}
          toolProvider={tools}
          onAction={act}
          onParseResult={setParsed}
          {...(startState === undefined ? {} : { initialState: startState })}
          onStateUpdate={(next) => {
            state.current = next;
            if (stateKey !== undefined) storeState(stateKey, next);
            onStateChange?.(next);
          }}
          publishObservability={false}
        />
        {pendingWrite && client !== null ? (
          <div className="mt-3">
            <ApprovalCard
              key={pendingWrite.id}
              client={client}
              workspaceId={pendingWrite.request.workspaceId}
              args={pendingWrite.request.args}
              applyWithoutAsking={applyWithoutAsking}
              held={held || followsLockedRead}
              scope={
                scopeRoot === undefined
                  ? undefined
                  : { rootItemId: scopeRoot, readOnly: scopeReadOnly }
              }
              onDecide={(decision) => {
                // A click moves focus to the block as the card leaves; an auto-run never does.
                if (!(decision.approved && decision.withoutAsking)) block.current?.focus();
                pendingWrite.settle(decision);
                setWrites((pending) => pending.filter((write) => write.id !== pendingWrite.id));
              }}
            />
          </div>
        ) : null}
        {saveable && client !== null && !streaming && parsed?.root ? (
          <div className="mt-3 flex flex-col gap-2">
            {saving ? (
              <SaveArtifact
                program={program}
                state={saving.state}
                defaultWorkspaceId={workspaceIds[0] ?? ''}
                onClose={() => {
                  setSaving(null);
                }}
              />
            ) : (
              <div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSaving({ state: storableState(state.current) });
                  }}
                >
                  Save as artifact
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </OpenUiScope.Provider>
  );
}
