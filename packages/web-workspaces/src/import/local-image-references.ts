/**
 * Rewrites only standalone Markdown image fallbacks whose source path matches an uploaded file.
 * The document keeps a durable file-item id, never an expiring object-storage capability URL.
 */

interface JsonNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly JsonNode[];
  readonly text?: string;
  readonly marks?: readonly {
    readonly type: string;
    readonly attrs?: Readonly<Record<string, unknown>>;
  }[];
}

export function rewriteLocalImageReferences(
  doc: unknown,
  notePath: string,
  localImageTargets: readonly string[],
  attachmentItemIds: ReadonlyMap<string, string>,
): { readonly doc: unknown; readonly resolved: number } {
  if (!isNode(doc) || localImageTargets.length === 0) return { doc, resolved: 0 };
  const candidates = new Set(localImageTargets.map(normalizeTarget));
  return rewriteNode(doc, notePath, candidates, attachmentItemIds);
}

function rewriteNode(
  node: JsonNode,
  notePath: string,
  candidates: ReadonlySet<string>,
  attachmentItemIds: ReadonlyMap<string, string>,
): { readonly doc: JsonNode; readonly resolved: number } {
  const image = asImportedImage(node, notePath, candidates, attachmentItemIds);
  if (image !== null) return { doc: image, resolved: 1 };
  if (node.content === undefined) return { doc: node, resolved: 0 };

  let resolved = 0;
  const content = node.content.map((child) => {
    const rewritten = rewriteNode(child, notePath, candidates, attachmentItemIds);
    resolved += rewritten.resolved;
    return rewritten.doc;
  });
  return { doc: { ...node, content }, resolved };
}

function asImportedImage(
  node: JsonNode,
  notePath: string,
  candidates: ReadonlySet<string>,
  attachmentItemIds: ReadonlyMap<string, string>,
): JsonNode | null {
  const text =
    node.type === 'paragraph' && node.content?.length === 1 ? node.content[0] : undefined;
  const link = text?.marks?.find((mark) => mark.type === 'link');
  const href = typeof link?.attrs?.href === 'string' ? link.attrs.href : null;
  if (text?.type !== 'text' || href === null || !candidates.has(normalizeTarget(href))) return null;

  const fileItemId = attachmentItemIds.get(resolvePath(notePath, href));
  if (fileItemId === undefined) return null;
  return {
    type: 'image',
    attrs: {
      src: '',
      alt: text.text ?? href,
      title: typeof link?.attrs?.title === 'string' ? link.attrs.title : null,
      fileItemId,
    },
  };
}

function resolvePath(notePath: string, target: string): string {
  const segments = notePath.split('/').slice(0, -1);
  for (const segment of normalizeTarget(target).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

function normalizeTarget(target: string): string {
  const withoutSuffix = target.trim().replace(/[?#][\s\S]*$/, '');
  try {
    return decodeURIComponent(withoutSuffix).replace(/\\/g, '/');
  } catch {
    return withoutSuffix.replace(/\\/g, '/');
  }
}

function isNode(value: unknown): value is JsonNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}
