import { nixSchema } from '@nix/editor-schema';
import { markdownToDocument } from '@nix/markdown';
import { Button, Icon, Text } from '@nix/ui';
import type { Node as DocumentNode } from '@tiptap/pm/model';
import { Check, Copy, X } from 'lucide-react';
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';

import { pieceKind, type ProgramPiece } from '../openui/fence';

// The renderer is its own chunk, loaded on first use.
const OpenUiBlock = lazy(() => import('../openui/openui-block'));

function workspaceHref(href: string, workspaceIds: readonly string[]): boolean {
  const match = /^\/w\/([a-f0-9-]{36})\/?\?item=[a-f0-9-]{36}$/.exec(href);
  return workspaceIds.includes(match?.[1] ?? '');
}

function plainText(text: string, workspaceIds: readonly string[]): ReactNode {
  const pattern =
    /\[([^\]\n]{1,240})\]\((\/w\/([a-f0-9-]{36})\/?\?item=([a-f0-9-]{36}))\)|(?<![\w/:])(\/w\/([a-f0-9-]{36})\/?\?item=([a-f0-9-]{36}))/g;
  const parts: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (!workspaceIds.includes(match[3] ?? match[6] ?? '')) continue;
    parts.push(text.slice(start, match.index));
    parts.push(
      <Link key={match.index} to={match[2] ?? match[5] ?? ''} className="underline">
        {match[1] ?? 'Open note'}
      </Link>,
    );
    start = match.index + match[0].length;
  }
  return (
    <>
      {parts}
      {text.slice(start)}
    </>
  );
}

/** Fenced code with a copy button, highlighted once the highlighter has loaded. The HTML is
 * highlight.js output, which escapes the code and emits only class spans; their colours are text
 * roles (accent and muted), so they keep the contrast of the code block's background. The
 * highlighter is a separate chunk, so the code shows as plain text until it arrives. */
function CodeBlock({
  code,
  language,
}: {
  readonly code: string;
  readonly language: string | null;
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [html, setHtml] = useState<{ readonly code: string; readonly html: string } | null>(null);
  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => {
      setCopy('idle');
    }, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, [copy]);
  useEffect(() => {
    let live = true;
    void import('@nix/site-render/highlight').then((module) => {
      if (live) setHtml({ code, html: module.highlightCode(code, language) });
    });
    return () => {
      live = false;
    };
  }, [code, language]);
  return (
    <div className="relative">
      <pre className="max-w-full overflow-x-auto rounded-sm border border-divider bg-surface p-3 pr-12 [&_.hljs-built_in]:text-accent-text [&_.hljs-comment]:text-muted [&_.hljs-keyword]:text-accent-text [&_.hljs-literal]:text-accent-text [&_.hljs-title]:text-accent-text [&_.hljs-type]:text-accent-text">
        <Text as="span" className="font-mono">
          {html?.code === code ? (
            <code dangerouslySetInnerHTML={{ __html: html.html }} />
          ) : (
            <code>{code}</code>
          )}
        </Text>
      </pre>
      <Button
        variant="icon"
        className="absolute right-1 top-1"
        aria-label={copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy code'}
        onClick={() => {
          navigator.clipboard.writeText(code).then(
            () => {
              setCopy('copied');
            },
            () => {
              setCopy('failed');
            },
          );
        }}
      >
        <Icon icon={copy === 'copied' ? Check : copy === 'failed' ? X : Copy} size="sm" />
      </Button>
    </div>
  );
}

interface MessageHeading {
  readonly sourceLevel: number;
  readonly level: number;
}

/** The conversation owns h2. Each reply starts at h3 and preserves source nesting without skips. */
function messageHeading(value: unknown, outline: MessageHeading[]): 'h3' | 'h4' | 'h5' | 'h6' {
  const sourceLevel =
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6 ? value : 1;
  while (outline.length > 0 && (outline.at(-1)?.sourceLevel ?? 0) >= sourceLevel) outline.pop();
  const level = Math.min(6, (outline.at(-1)?.level ?? 2) + 1);
  outline.push({ sourceLevel, level });
  return (['h3', 'h4', 'h5', 'h6'] as const)[level - 3] ?? 'h3';
}

/** What a generated-UI block in this message needs from the conversation around it. */
interface OpenUiContext {
  readonly streaming: boolean;
  readonly onAsk: ((message: string) => void) | undefined;
  /** The message's id, so each block's state is kept under its own key. */
  readonly messageId: string | undefined;
  /** Blocks seen so far in this message, numbering each one's state key. */
  blocks: number;
  readonly applyWithoutAsking: boolean;
  /** Generated-UI blocks so far: the conversation's earlier ones, then this message's. */
  readonly pieces: ProgramPiece[];
  readonly followsLockedRead: boolean;
  readonly noteScope: { readonly rootItemId: string; readonly readOnly: boolean } | undefined;
  readonly readOnly: boolean;
}

/** Render a validated document through React; model HTML, images and external URLs stay inert. */
function messageNode(
  node: DocumentNode,
  workspaceIds: readonly string[],
  outline: MessageHeading[],
  openUi: OpenUiContext,
): ReactNode {
  const children: ReactNode[] = [];
  node.forEach((child, _offset, index) => {
    children.push(
      <Fragment key={index}>{messageNode(child, workspaceIds, outline, openUi)}</Fragment>,
    );
  });
  switch (node.type.name) {
    case 'text': {
      const literal = node.marks.some(
        (mark) => mark.type.name === 'code' || mark.type.name === 'link',
      );
      let content: ReactNode = literal ? node.text : plainText(node.text ?? '', workspaceIds);
      for (const mark of node.marks) {
        switch (mark.type.name) {
          case 'bold':
            content = <strong className="font-semibold">{content}</strong>;
            break;
          case 'italic':
            content = <em>{content}</em>;
            break;
          case 'strike':
            content = <s>{content}</s>;
            break;
          case 'code':
            content = <code className="rounded-sm bg-surface px-1 font-mono">{content}</code>;
            break;
          case 'link': {
            const href = typeof mark.attrs.href === 'string' ? mark.attrs.href : '';
            if (workspaceHref(href, workspaceIds))
              content = (
                <Link to={href} className="underline">
                  {content}
                </Link>
              );
            break;
          }
        }
      }
      return content;
    }
    case 'paragraph':
      return (
        <Text as="p" className="whitespace-pre-wrap">
          {children}
        </Text>
      );
    case 'heading': {
      const level = messageHeading(node.attrs.level, outline);
      return (
        <Text as={level} variant={level}>
          {children}
        </Text>
      );
    }
    case 'bulletList':
      return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
    case 'orderedList':
      return (
        <ol start={Number(node.attrs.start) || 1} className="list-decimal space-y-1 pl-5">
          {children}
        </ol>
      );
    case 'listItem':
      return <li className="space-y-1">{children}</li>;
    case 'blockquote':
    case 'callout':
      return (
        <blockquote className="space-y-2 border-l-2 border-divider pl-3">{children}</blockquote>
      );
    case 'codeBlock': {
      const language = typeof node.attrs.language === 'string' ? node.attrs.language : null;
      const code = <CodeBlock code={node.textContent} language={language} />;
      const kind = pieceKind(language);
      if (kind === null) return code;
      const block = openUi.blocks++;
      const base = kind === 'patch' ? [...openUi.pieces] : undefined;
      openUi.pieces.push({ patch: kind === 'patch', source: node.textContent });
      return (
        <Suspense fallback={code}>
          <OpenUiBlock
            source={node.textContent}
            workspaceIds={workspaceIds}
            streaming={openUi.streaming}
            onAsk={openUi.onAsk}
            fallback={code}
            stateKey={
              openUi.messageId === undefined ? undefined : `${openUi.messageId}:${String(block)}`
            }
            saveable
            applyWithoutAsking={openUi.applyWithoutAsking}
            base={base}
            followsLockedRead={openUi.followsLockedRead}
            noteScope={openUi.noteScope}
            readOnly={openUi.readOnly}
          />
        </Suspense>
      );
    }
    case 'hardBreak':
      return <br />;
    case 'horizontalRule':
      return <hr className="border-divider" />;
    case 'table':
      return (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full border-collapse">
            <tbody>{children}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr>{children}</tr>;
    case 'tableHeader':
      return (
        <th scope="col" className="border border-divider bg-surface p-2 text-left font-semibold">
          {children}
        </th>
      );
    case 'tableCell':
      return <td className="border border-divider p-2 align-top">{children}</td>;
    case 'image':
      return (
        <Text as="span">{`![${String(node.attrs.alt ?? '')}](${String(node.attrs.src ?? '')})`}</Text>
      );
    case 'reference':
      return <Text as="span">{String(node.attrs.label ?? '')}</Text>;
    default:
      return <>{children}</>;
  }
}

/** Assistant Markdown is formatting only; citations navigate within explicitly supplied workspaces. */
export function PetMessageText({
  text,
  workspaceId,
  format = 'markdown',
  sourceWorkspaceIds = [],
  streaming = false,
  onAsk,
  messageId,
  applyWithoutAsking = false,
  earlierPieces,
  followsLockedRead = false,
  noteScope,
  readOnly = false,
}: {
  readonly text: string;
  readonly workspaceId: string;
  readonly format?: 'markdown' | 'plain';
  readonly sourceWorkspaceIds?: readonly string[];
  /** A draft still arriving: generated UI renders progressively and its buttons wait. */
  readonly streaming?: boolean;
  /** Puts a generated-UI button's request to the pet in the composer, for the owner to send. */
  readonly onAsk?: ((message: string) => void) | undefined;
  /** Keys generated-UI state per message; without it a block's state is not kept. */
  readonly messageId?: string | undefined;
  /** The conversation's "Apply without asking" switch, for writes its components request. */
  readonly applyWithoutAsking?: boolean;
  /** Generated-UI blocks from earlier in the conversation, which a patch block here changes. */
  readonly earlierPieces?: readonly ProgramPiece[] | undefined;
  /** The conversation already read locked content: its components' writes wait for the owner. */
  readonly followsLockedRead?: boolean;
  /** A note-scoped conversation's scope, which bounds its components too. */
  readonly noteScope?: { readonly rootItemId: string; readonly readOnly: boolean } | undefined;
  /** Components here only read: they never offer a write. */
  readonly readOnly?: boolean;
}): ReactElement {
  const sourceKey = sourceWorkspaceIds.join(',');
  const parsed = useMemo(
    () => (format === 'markdown' ? markdownToDocument(text) : undefined),
    [format, text],
  );
  // The document tree is the costly part of a reply, and a streamed update re-renders every
  // message: rebuild it only when this message's own inputs change.
  const tree = useMemo(() => {
    if (!parsed?.ok) return null;
    const workspaceIds = [workspaceId, ...(sourceKey ? sourceKey.split(',') : [])];
    return messageNode(nixSchema.nodeFromJSON(parsed.doc), workspaceIds, [], {
      streaming,
      onAsk,
      messageId,
      blocks: 0,
      applyWithoutAsking,
      pieces: [...(earlierPieces ?? [])],
      followsLockedRead,
      noteScope,
      readOnly,
    });
  }, [
    parsed,
    workspaceId,
    sourceKey,
    streaming,
    onAsk,
    messageId,
    applyWithoutAsking,
    earlierPieces,
    followsLockedRead,
    noteScope,
    readOnly,
  ]);
  if (!tree) {
    return (
      <Text className="min-w-0 whitespace-pre-wrap wrap-anywhere">
        {plainText(text, [workspaceId, ...sourceWorkspaceIds])}
      </Text>
    );
  }
  return <div className="flex min-w-0 max-w-full flex-col gap-3 wrap-anywhere">{tree}</div>;
}
