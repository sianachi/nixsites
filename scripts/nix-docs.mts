import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const USAGE = 'Usage: nix-docs [list|read query|source original-path|check]';
const MAX_BYTES = 64 << 20;
const MAX_ENTRY_BYTES = 8 << 20;
const MAX_ITEMS = 10000;

// The committed archives predate packages/export's strict reader (no omitted/loss lists), so this
// reads the zip directly and applies the checks the Go reader made.
interface ItemBundle {
  id: string;
  parentId: string | null;
  seq: string;
  title: string;
  type: string;
  body: unknown;
}
interface Manifest {
  root: string;
  items: Pick<ItemBundle, 'id' | 'parentId' | 'seq' | 'title' | 'type'>[];
  files?: unknown[];
  loss?: unknown[];
  omitted?: unknown[];
}

interface Row {
  slug?: string;
  sourcePath?: string;
  title: string;
  itemId: string;
  archive: string;
  sourceItemId?: string;
  sourceSha256?: string;
  sourceBytes?: number;
}
interface Catalog {
  archives: { path: string; sha256: string; itemCount: number }[];
  pages?: Row[];
  documents?: Row[];
  containers?: Row[];
}
interface Library {
  catalog: Catalog;
  archives: Map<string, ItemBundle[]>;
}
interface Node {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  marks?: Node[];
}

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const records = (catalog: Catalog): Row[] => [
  ...(catalog.pages ?? []),
  ...(catalog.documents ?? []),
  ...(catalog.containers ?? []),
];

function bodyNode(bundle: ItemBundle): Node {
  const doc = (bundle.body as { prosemirror?: Node } | null)?.prosemirror;
  if (doc?.type !== 'doc') throw new Error('documentation note has no native document body');
  return doc;
}

export function originalSource(bundle: ItemBundle): string {
  const { content = [] } = bodyNode(bundle);
  const [block] = content;
  if (content.length !== 1 || block?.type !== 'codeBlock') {
    throw new Error('preserved source must be one verbatim code block');
  }
  return (block.content ?? [])
    .map((child) => {
      if (child.type !== 'text') throw new Error('preserved source contains a non-text node');
      return child.text ?? '';
    })
    .join('');
}

/** Plain-text rendering of a note; internal links become `label (nix://item/<id>)`. */
export function renderBundle(bundle: ItemBundle): string {
  const attr = (part: Node, key: string): string => {
    const value = part.attrs?.[key];
    return typeof value === 'string' ? value : '';
  };
  const link = (label: string, target: string): string => `${label} (nix://item/${target})`;
  const inline = (part: Node): string => {
    if (part.type === 'text') {
      let value = part.text ?? '';
      for (const mark of part.marks ?? []) {
        if (mark.type !== 'link') continue;
        const href = attr(mark, 'href');
        if (href.startsWith('nix://item/')) value = link(value, href.slice('nix://item/'.length));
        else if (href !== '' && href !== value) value += ` (${href})`;
      }
      return value;
    }
    if (part.type === 'reference')
      return link(attr(part, 'label') || 'Item', attr(part, 'targetId'));
    if (part.type === 'hardBreak') return '\n';
    return (part.content ?? []).map(inline).join('');
  };
  const blocks = (part: Node, indent: string): string[] => {
    switch (part.type) {
      case 'codeBlock': {
        const code = (part.content ?? []).map((child) => child.text ?? '').join('');
        const fence = code.includes('```') ? '````' : '```';
        return [fence + attr(part, 'language'), ...code.split('\n'), fence, ''];
      }
      case 'heading': {
        const level = typeof part.attrs?.level === 'number' ? Math.trunc(part.attrs.level) : 0;
        return [`${indent}${'#'.repeat(Math.max(1, Math.min(6, level)))} ${inline(part)}`, ''];
      }
      case 'paragraph':
        return [
          ...inline(part)
            .split('\n')
            .map((line) => indent + line),
          '',
        ];
      case 'bulletList':
      case 'orderedList': {
        const start = typeof part.attrs?.start === 'number' ? Math.trunc(part.attrs.start) : 1;
        const lines = (part.content ?? []).flatMap((child, index) => {
          const body = blocks(child, `${indent}  `);
          const marker = part.type === 'orderedList' ? `${start + index}. ` : '- ';
          if (body.length !== 0) body[0] = indent + marker + body[0]!.replace(/^ +/, '');
          return body;
        });
        return [...lines, ''];
      }
      case 'table':
        return [
          ...(part.content ?? []).map(
            (row) =>
              indent +
              (row.content ?? []).map((cell) => inline(cell).replaceAll('\n', ' ')).join(' | '),
          ),
          '',
        ];
      case 'horizontalRule':
        return ['---', ''];
    }
    const lines = (part.content ?? []).flatMap((child) => blocks(child, indent));
    return part.type === 'blockquote' ? lines.map((line) => `> ${line}`) : lines;
  };
  return `${blocks(bodyNode(bundle), '').join('\n').replace(/\n+$/, '')}\n`;
}

/** Entry name -> bytes of a zip, bounded before inflating; entry order is kept. */
function unzip(data: Buffer): Map<string, Buffer> {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip archive');
  const count = data.readUInt16LE(end + 10);
  if (count === 0 || count > MAX_ITEMS + 1) {
    throw new Error('missing first manifest or too many archive entries');
  }
  const entries = new Map<string, Buffer>();
  let total = 0;
  let at = data.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = data.readUInt16LE(at + 10);
    const packedSize = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extra = data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra;
    if (entries.has(name)) throw new Error('duplicate archive entry');
    if (size > MAX_ENTRY_BYTES) throw new Error('documentation entry exceeds its size limit');
    total += size;
    if (total > MAX_BYTES) throw new Error('documentation archive exceeds its expanded size limit');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const packed = data.subarray(start, start + packedSize);
    if (method !== 0 && method !== 8) throw new Error('unsupported zip compression');
    const bytes =
      method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: MAX_ENTRY_BYTES });
    entries.set(name, bytes);
  }
  if (entries.keys().next().value !== 'manifest.json') {
    throw new Error('missing first manifest or too many archive entries');
  }
  return entries;
}

async function readArchiveFile(root: string, desc: Catalog['archives'][number]) {
  const path = resolve(root, desc.path);
  if (isAbsolute(desc.path) || !path.startsWith(`${root}/`)) {
    throw new Error('archive path must stay inside the repository');
  }
  if (!(await stat(path)).isFile() || (await stat(path)).size > MAX_BYTES) {
    throw new Error('documentation archive exceeds its size limit');
  }
  const data = await readFile(path);
  if (sha256(data) !== desc.sha256) throw new Error('archive checksum mismatch');
  const entries = unzip(data);
  const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as Manifest;
  if (!Array.isArray(manifest.items) || manifest.items.length > MAX_ITEMS) {
    throw new Error('invalid documentation manifest');
  }
  if (manifest.files?.length || manifest.loss?.length || manifest.omitted?.length) {
    throw new Error('documentation must be prose-only without loss or omitted content');
  }
  if (manifest.items.length !== desc.itemCount || entries.size !== manifest.items.length + 1) {
    throw new Error('documentation archive item set is incomplete');
  }
  const seen = new Set<string>();
  let roots = 0;
  const bundles = manifest.items.map((item) => {
    const raw = entries.get(`items/${item.id}.json`);
    if (!raw) throw new Error(`missing archive entry items/${item.id}.json`);
    const bundle = JSON.parse(raw.toString('utf8')) as ItemBundle;
    if (
      bundle.id !== item.id ||
      (bundle.parentId ?? null) !== (item.parentId ?? null) ||
      bundle.seq !== item.seq ||
      bundle.title !== item.title ||
      bundle.type !== item.type
    ) {
      throw new Error('item and manifest disagree');
    }
    if (bundle.parentId == null) {
      roots++;
      if (bundle.id !== manifest.root) throw new Error('invalid documentation root');
    } else if (!seen.has(bundle.parentId)) {
      throw new Error('invalid documentation parent order');
    }
    seen.add(bundle.id);
    return bundle;
  });
  if (roots !== 1) throw new Error('invalid documentation root count');
  return bundles;
}

function findRoot(): string {
  let path = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsCatalog(path)) return path;
    const parent = dirname(path);
    if (parent === path) throw new Error('cannot find docs/nix/catalog.json');
    path = parent;
  }
}
const existsCatalog = (path: string): boolean => {
  try {
    return statSync(join(path, 'docs/nix/catalog.json')).isFile();
  } catch {
    return false;
  }
};

const bundleOf = (lib: Library, archive: string, id: string): ItemBundle => {
  const bundle = lib.archives.get(archive)?.find((candidate) => candidate.id === id);
  if (!bundle) throw new Error(`catalog points to absent note ${id}`);
  return bundle;
};

async function load(root: string): Promise<Library> {
  const catalog = JSON.parse(
    await readFile(join(root, 'docs/nix/catalog.json'), 'utf8'),
  ) as Catalog;
  const count = catalog.archives?.length ?? 0;
  if (count === 0 || count > 100) throw new Error('documentation archive count is outside limits');
  const lib: Library = { catalog, archives: new Map() };
  for (const desc of catalog.archives) {
    if (lib.archives.has(desc.path)) throw new Error('duplicate catalog archive');
    try {
      lib.archives.set(desc.path, await readArchiveFile(root, desc));
    } catch (error) {
      throw new Error(`${desc.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const row of records(catalog)) {
    bundleOf(lib, row.archive, row.itemId);
    if (!row.sourceItemId) continue;
    const source = originalSource(bundleOf(lib, row.archive, row.sourceItemId));
    if (Buffer.byteLength(source) !== row.sourceBytes || sha256(source) !== row.sourceSha256) {
      throw new Error(`source preservation failed: ${row.sourcePath ?? ''}`);
    }
  }
  return lib;
}

function selectRecord(lib: Library, query: string): Row {
  const rows = records(lib.catalog);
  const exact = rows.filter((row) => [row.slug, row.sourcePath, row.itemId].includes(query));
  const lower = query.toLowerCase();
  const matches = exact.length
    ? exact
    : rows.filter((row) => row.title.toLowerCase().includes(lower));
  if (matches.length !== 1) {
    throw new Error(
      `expected one match for ${JSON.stringify(query)}; found ${matches.length}; use list to select a path or slug`,
    );
  }
  return matches[0]!;
}

export async function run(args: string[]): Promise<string> {
  const [command, query = ''] = args;
  if (args.length > 2 || command === undefined) throw new Error(USAGE);
  if (command === '--help' || command === '-h') return `${USAGE}\n`;
  if (!['list', 'read', 'source', 'check'].includes(command)) {
    throw new Error(`unknown command "${command}"`);
  }
  if ((command === 'read' || command === 'source') && query === '') {
    throw new Error('read and source require a page slug, document path or title');
  }
  if ((command === 'list' || command === 'check') && query !== '') {
    throw new Error(`${command} does not accept a query`);
  }
  const lib = await load(findRoot());
  if (command === 'list') {
    return records(lib.catalog)
      .map((row) => `${row.slug || row.sourcePath || row.itemId}\t${row.title}\n`)
      .join('');
  }
  if (command === 'check') {
    const { pages = [], documents = [] } = lib.catalog;
    return `Verified ${lib.archives.size} native archives, ${pages.length} guide pages and ${documents.length} exact source documents.\n`;
  }
  const row = selectRecord(lib, query);
  if (command === 'read') return renderBundle(bundleOf(lib, row.archive, row.itemId));
  if (!row.sourceItemId) throw new Error('this native guide has no original Markdown source');
  return originalSource(bundleOf(lib, row.archive, row.sourceItemId));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (output) => process.stdout.write(output),
    (error: unknown) => {
      console.error('nix-docs:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
