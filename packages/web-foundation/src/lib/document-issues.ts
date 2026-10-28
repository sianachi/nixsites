export interface DocumentIssue {
  readonly key: string;
  readonly message: string;
  readonly reload?: boolean;
}

interface Source {
  readonly issues: readonly DocumentIssue[];
  readonly connection: DocumentIssue | null;
  readonly paused: boolean;
}

interface Snapshot {
  readonly host: string | null;
  readonly issues: readonly DocumentIssue[];
}

const sources = new Map<string, Source>();
const acknowledged = new Set<string>();
const listeners = new Set<() => void>();
const EMPTY: Snapshot = { host: null, issues: [] };
let snapshot = EMPTY;

function publish(): void {
  const active = new Map<string, DocumentIssue>();
  for (const source of sources.values()) {
    for (const issue of source.issues) active.set(issue.key, issue);
    if (source.connection) active.set(source.connection.key, source.connection);
  }
  for (const key of acknowledged) if (!active.has(key)) acknowledged.delete(key);
  const paused = Array.from(sources.values()).some((source) => source.paused);
  snapshot = {
    host: sources.keys().next().value ?? null,
    issues: paused
      ? []
      : Array.from(active.values()).filter((issue) => !acknowledged.has(issue.key)),
  };
  for (const listener of listeners) listener();
}

/** Connecting is a retry, not proof of recovery: retain the current incident until it resolves. */
export function updateDocumentIssues(
  id: string,
  issues: readonly DocumentIssue[],
  connection: DocumentIssue | null | undefined,
  paused: boolean,
): void {
  sources.set(id, {
    issues,
    connection: connection === undefined ? (sources.get(id)?.connection ?? null) : connection,
    paused,
  });
  publish();
}

export function removeDocumentIssues(id: string): void {
  sources.delete(id);
  publish();
}

/** Acknowledge the whole incident once, including errors shared by several open panes. */
export function acknowledgeDocumentIssues(): void {
  for (const issue of snapshot.issues) acknowledged.add(issue.key);
  publish();
}

export function documentIssuesSnapshot(): Snapshot {
  return snapshot;
}

export function emptyDocumentIssues(): Snapshot {
  return EMPTY;
}

export function subscribeDocumentIssues(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
