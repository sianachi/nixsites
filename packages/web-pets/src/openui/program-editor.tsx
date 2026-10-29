import { createParser } from '@openuidev/react-lang';
import { Segmented, Text } from '@nix/ui';
import {
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { outline } from './designer-model';
import { nixLibrary } from './library';
import OpenUiBlock from './openui-block';
import { withContainer } from './starter-program';

/** The most a stored program may hold, in UTF-8 bytes; Core refuses a longer one. */
export const PROGRAM_LIMIT = 32 * 1024;

// The designer is its own chunk: Code mode, and every page that only shows a program, never load it.
const ProgramDesigner = lazy(() => import('./program-designer'));

const MODES = [
  { value: 'design', label: 'Design' },
  { value: 'code', label: 'Code' },
] as const;

const parser = createParser(nixLibrary.toJSONSchema());

export interface Diagnostic {
  /** 1-based line in the editor's text, or null when the problem is not on one line. */
  readonly line: number | null;
  readonly message: string;
}

function lineOf(source: string, pattern: RegExp): number | null {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? null : index + 1;
}

/**
 * What is wrong with a program, as the library's parser sees it. The parser reports a problem by
 * statement name, not position, so a line number is the line that statement starts on.
 */
export function diagnose(source: string): Diagnostic[] {
  if (source.trim() === '') return [];
  const result = parser.parse(source);
  const found: Diagnostic[] = [];
  for (const error of result.meta.errors) {
    const statement = error.statementId;
    found.push({
      line:
        statement === undefined
          ? null
          : lineOf(source, new RegExp(`^\\s*${statement.replace(/\W/g, '\\$&')}\\s*=`)),
      message: error.message,
    });
  }
  for (const name of new Set(result.meta.unresolved)) {
    found.push({
      line: lineOf(source, new RegExp(`\\b${name.replace(/\W/g, '\\$&')}\\b`)),
      message: `"${name}" is used but never defined.`,
    });
  }
  if (result.root === null)
    found.push({ line: null, message: 'The program needs a root: root = Stack([...]).' });
  return found.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
}

/** The highlighter is its own chunk (shared with the pet's code blocks); until it arrives, and
 * whenever it is behind the text, the layer shows the plain text so the two never disagree. */
function useHighlighted(code: string): string | null {
  const [html, setHtml] = useState<{ readonly code: string; readonly html: string } | null>(null);
  useEffect(() => {
    let live = true;
    void import('@nix/site-render/highlight').then((module) => {
      if (live) setHtml({ code, html: module.highlightCode(code, 'openui-lang') });
    });
    return () => {
      live = false;
    };
  }, [code]);
  return html?.code === code ? html.html : null;
}

// Both layers share these so a character sits in the same place in each.
const TEXT_LAYER =
  'absolute inset-0 m-0 box-border whitespace-pre p-2 font-mono text-sm leading-5 [tab-size:2]';

/**
 * Edits an openui-lang program in Design (a visual designer) or Code: a plain textarea over a highlighted copy of its text (the
 * textarea's own text is transparent, so its caret, selection and undo are the browser's), the
 * parser's problems with line numbers under it, and a read-only live preview beside it. Design
 * opens first when the program has a root to design, and Code otherwise; both edit the same text.
 *
 * shortcut: no autocomplete, bracket matching or find; add a code-editor library if programs grow
 * past what a textarea handles.
 */
export function ProgramEditor({
  value,
  onChange,
  workspaceId,
  containerId,
  label = 'Program',
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly workspaceId: string;
  /** For a view: the collection `$container` stands for in the program and its preview. */
  readonly containerId?: string | null;
  readonly label?: string;
}): ReactNode {
  const layer = useRef<HTMLPreElement>(null);
  const highlighted = useHighlighted(value);
  const shown = useDeferredValue(value);
  const program = useMemo(
    () => (containerId === undefined ? shown : withContainer(shown, containerId)),
    [shown, containerId],
  );
  const problems = useMemo(() => diagnose(program), [program]);
  const bytes = new TextEncoder().encode(value).length;

  const [mode, setMode] = useState<'design' | 'code'>(() =>
    outline(value) === null ? 'code' : 'design',
  );

  const notes = (
    <>
      {bytes > PROGRAM_LIMIT ? (
        <Text variant="note" role="alert">
          This program is {Math.ceil(bytes / 1024)} KB; the limit is {PROGRAM_LIMIT / 1024} KB.
        </Text>
      ) : null}
      {problems.length === 0 ? null : (
        <ul aria-label="Problems" className="flex flex-col gap-1">
          {problems.map((problem) => (
            <li key={`${String(problem.line)}:${problem.message}`}>
              <Text variant="note" role="alert">
                {problem.line === null ? '' : `Line ${String(problem.line)}: `}
                {problem.message}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          // Its options share the width equally, so it needs one of its own.
          className="w-48 shrink-0"
          label="Editor mode"
          options={MODES}
          value={mode}
          onChange={setMode}
        />
        {mode === 'code' && value.trim() !== '' && outline(value) === null ? (
          <Text variant="note" tone="muted">
            Design needs a program that parses and has a root.
          </Text>
        ) : null}
      </div>
      {mode === 'design' ? (
        <>
          <Suspense
            fallback={
              <Text variant="note" role="status">
                Loading the designer…
              </Text>
            }
          >
            <ProgramDesigner
              value={value}
              onChange={onChange}
              workspaceId={workspaceId}
              containerId={containerId}
            />
          </Suspense>
          <div className="flex flex-col gap-2">{notes}</div>
        </>
      ) : (
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="relative h-72 rounded-sm border border-divider bg-surface focus-within:border-foreground">
              <pre ref={layer} aria-hidden className={`${TEXT_LAYER} overflow-hidden`}>
                {highlighted === null ? (
                  value
                ) : (
                  <code dangerouslySetInnerHTML={{ __html: highlighted }} />
                )}
                {'\n'}
              </pre>
              {/* A bare textarea on purpose: <Textarea> adds padding and a face that would move its
              text off the highlighted layer. */}
              <textarea
                aria-label={label}
                value={value}
                wrap="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className={`${TEXT_LAYER} resize-none overflow-auto bg-transparent text-transparent caret-foreground outline-none selection:bg-accent/30`}
                onChange={(event) => {
                  onChange(event.target.value);
                }}
                onScroll={(event) => {
                  if (layer.current) {
                    layer.current.scrollTop = event.currentTarget.scrollTop;
                    layer.current.scrollLeft = event.currentTarget.scrollLeft;
                  }
                }}
              />
            </div>
            {notes}
          </div>
          <div className="min-w-0" aria-label="Preview" role="region">
            {shown.trim() === '' ? (
              <Text variant="note" tone="muted">
                The preview shows here.
              </Text>
            ) : (
              // Reads only: a preview never asks for a write, so trying a program changes nothing.
              <OpenUiBlock
                source={program}
                readOnly
                workspaceIds={[workspaceId]}
                fallback={
                  <Text variant="note" tone="muted">
                    The program does not render yet.
                  </Text>
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
