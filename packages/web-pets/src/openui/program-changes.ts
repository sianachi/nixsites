export interface ProgramChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly name: string;
  readonly before?: string;
  readonly after?: string;
}

/** Statements by name: a line starting `name =` opens one, indented or blank lines continue it. */
function statements(source: string): Map<string, string> {
  const found = new Map<string, string>();
  let name: string | null = null;
  for (const line of source.split('\n')) {
    const head = /^(\$?\w+)\s*=/.exec(line);
    if (head?.[1] !== undefined) {
      name = head[1];
      found.set(name, line);
    } else if (name !== null) found.set(name, `${found.get(name) ?? ''}\n${line}`);
  }
  for (const [key, text] of found) found.set(key, text.trimEnd());
  return found;
}

/** What differs between two programs, by statement, in the order the new one reads. */
export function programChanges(before: string, after: string): ProgramChange[] {
  const old = statements(before);
  const next = statements(after);
  const out: ProgramChange[] = [];
  for (const [name, text] of next) {
    const was = old.get(name);
    if (was === undefined) out.push({ kind: 'added', name, after: text });
    else if (was !== text) out.push({ kind: 'changed', name, before: was, after: text });
  }
  for (const [name, text] of old)
    if (!next.has(name)) out.push({ kind: 'removed', name, before: text });
  return out;
}

export const countChanges = (before: string, after: string): number =>
  before === after ? 0 : Math.max(1, programChanges(before, after).length);

export const plural = (count: number): string =>
  `${String(count)} ${count === 1 ? 'change' : 'changes'}`;
