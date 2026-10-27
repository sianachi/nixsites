// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import config from '../../../vite.config';

interface GenerateBundlePlugin {
  readonly name: string;
  readonly generateBundle: (
    this: {
      emitFile: (asset: { fileName: string; source: string }) => void;
      getModuleInfo: (
        id: string,
      ) => { importedIds: string[]; dynamicallyImportedIds: string[] } | null;
    },
    options: unknown,
    bundle: Record<string, unknown>,
  ) => Promise<void>;
}

function findPwaAssetsPlugin(): GenerateBundlePlugin {
  const plugins = (config.plugins ?? []).flat() as Plugin[];
  const plugin = plugins.find((candidate) => candidate.name === 'nix-pwa-assets');
  if (plugin === undefined || typeof plugin.generateBundle !== 'function') {
    throw new Error('The nix-pwa-assets plugin is missing or lost its generateBundle hook.');
  }
  return plugin as unknown as GenerateBundlePlugin;
}

/**
 * The build-time transform in `vite.config.ts`'s `nix-pwa-assets` plugin rewrites three exact
 * literals in `public/service-worker.js` (the version string and the two static asset arrays) and
 * ships the rest of the file untouched. This runs that transform for real - against the real
 * `service-worker.js` and `offline.html` on disk - and asserts both halves of that contract: the
 * literals actually change, and the push/notificationclick/pushsubscriptionchange handlers this
 * lane added survive the rewrite intact, since a regex `.replace` anywhere else in the file would
 * silently corrupt them.
 */
describe('the PWA asset build transform', () => {
  it('rewrites the version and asset lists while keeping the push handlers intact', async () => {
    const plugin = findPwaAssetsPlugin();
    const emitted: Record<string, string> = {};
    const context = {
      emitFile: (asset: { fileName: string; source: string }) => {
        emitted[asset.fileName] = asset.source;
      },
      getModuleInfo: () => null,
    };

    await plugin.generateBundle.call(
      context,
      {},
      {
        // The shape the native-feel shell reads to find what an installed launch needs: the entry
        // chunk, the one application chunk it loads dynamically, and their stylesheets.
        'assets/index-abc123.js': {
          type: 'chunk',
          fileName: 'assets/index-abc123.js',
          isEntry: true,
          moduleIds: [],
          modules: {},
          imports: [],
          dynamicImports: ['assets/app-abc123.js'],
          viteMetadata: { importedCss: new Set(['assets/index-abc123.css']) },
        },
        'assets/app-abc123.js': {
          type: 'chunk',
          fileName: 'assets/app-abc123.js',
          isEntry: false,
          moduleIds: [],
          modules: {},
          imports: [],
          dynamicImports: [],
        },
        'assets/index-abc123.css': { type: 'asset' },
        'assets/vendor-def456.woff2': { type: 'asset' },
        'not-an-asset.txt': { type: 'asset' },
      },
    );

    const worker = emitted['service-worker.js'];
    expect(worker).toBeDefined();
    expect(worker).not.toContain("'nix-pwa-dev'");
    expect(worker).toMatch(/const VERSION = "nix-pwa-[0-9a-f]{16}";/);
    expect(worker).toContain('/assets/index-abc123.js');
    expect(worker).toContain('/assets/vendor-def456.woff2');
    expect(worker).toContain('const SHELL_ENTRY = "/assets/index-abc123.js";');

    for (const handler of ['push', 'notificationclick', 'pushsubscriptionchange']) {
      expect(worker).toContain(`addEventListener('${handler}'`);
    }
    expect(worker).toContain('self.registration.showNotification(title, options)');
    expect(worker).toContain('.open(PUSH_KEY_CACHE)');
  });

  it('precaches only the startup graph, leaving Mermaid, KaTeX, canvas and PDF chunks lazy', async () => {
    const mermaidRoot = '/node_modules/.pnpm/mermaid@11/node_modules/mermaid/dist/mermaid.core.mjs';
    const flow = '/node_modules/mermaid/dist/flow.mjs';
    const sequence = '/node_modules/mermaid/dist/sequence.mjs';
    const shared = '/node_modules/mermaid/dist/shared.mjs';
    const layout = '/node_modules/layout/dist/index.mjs';
    const nestedLayout = '/node_modules/layout/dist/nested.mjs';
    const katex = '/node_modules/katex/dist/katex.mjs';
    const moduleGraph = new Map([
      [mermaidRoot, { importedIds: [shared], dynamicallyImportedIds: [flow, sequence] }],
      [shared, { importedIds: [], dynamicallyImportedIds: [katex] }],
      [flow, { importedIds: [shared], dynamicallyImportedIds: [layout] }],
      [sequence, { importedIds: [shared], dynamicallyImportedIds: [] }],
      [layout, { importedIds: [], dynamicallyImportedIds: [nestedLayout] }],
      [nestedLayout, { importedIds: [], dynamicallyImportedIds: [] }],
      [katex, { importedIds: [], dynamicallyImportedIds: [] }],
    ]);
    const emitted: Record<string, string> = {};
    const chunk = ({
      fileName,
      moduleIds = [],
      imports = [],
      dynamicImports = [],
    }: {
      fileName: string;
      moduleIds?: string[];
      imports?: string[];
      dynamicImports?: string[];
    }) => ({
      type: 'chunk',
      fileName,
      isEntry: false,
      moduleIds,
      modules: {},
      imports,
      dynamicImports,
    });

    await findPwaAssetsPlugin().generateBundle.call(
      {
        emitFile: (asset) => {
          emitted[asset.fileName] = asset.source;
        },
        getModuleInfo: (id) => moduleGraph.get(id) ?? null,
      },
      {},
      {
        'assets/index-main.js': {
          ...chunk({ fileName: 'assets/index-main.js', dynamicImports: ['assets/app-main.js'] }),
          isEntry: true,
          viteMetadata: {
            importedCss: new Set(['assets/index-main.css']),
            importedAssets: new Set(['assets/nunito.woff2']),
          },
        },
        // The application and Mermaid root share a chunk in a real Vite build.
        'assets/app-main.js': chunk({
          fileName: 'assets/app-main.js',
          moduleIds: ['/src/app.tsx', mermaidRoot, shared],
          dynamicImports: [
            'assets/flow.js',
            'assets/sequence.js',
            'assets/katex.js',
            'assets/canvas.js',
            'assets/pdf.js',
          ],
        }),
        'assets/flow.js': chunk({
          fileName: 'assets/flow.js',
          moduleIds: [flow],
          imports: ['assets/app-main.js'],
          dynamicImports: ['assets/layout.js'],
        }),
        'assets/sequence.js': {
          ...chunk({ fileName: 'assets/sequence.js', imports: ['assets/app-main.js'] }),
          modules: { [sequence]: {} },
        },
        'assets/layout.js': chunk({
          fileName: 'assets/layout.js',
          moduleIds: [layout],
          dynamicImports: ['assets/nested-layout.js'],
        }),
        'assets/nested-layout.js': chunk({
          fileName: 'assets/nested-layout.js',
          moduleIds: [nestedLayout],
        }),
        'assets/katex.js': {
          ...chunk({ fileName: 'assets/katex.js', moduleIds: [katex] }),
          viteMetadata: {
            importedCss: new Set(['assets/katex.css']),
            importedAssets: new Set(['assets/katex.ttf']),
          },
        },
        'assets/canvas.js': chunk({
          fileName: 'assets/canvas.js',
          moduleIds: ['/src/canvas/canvas-editor.tsx'],
        }),
        'assets/pdf.js': chunk({ fileName: 'assets/pdf.js', moduleIds: ['/src/files/pdf.tsx'] }),
        'assets/index-main.css': { type: 'asset' },
        'assets/katex.css': { type: 'asset' },
        'assets/nunito.woff2': { type: 'asset' },
        'assets/katex.ttf': { type: 'asset' },
      },
    );

    const worker = emitted['service-worker.js'];
    const shell = worker?.match(/const SHELL_ASSETS = (\[.*?\]);/u)?.[1];
    expect(shell).toBeDefined();
    for (const file of ['index-main.js', 'app-main.js', 'index-main.css', 'nunito.woff2'])
      expect(shell).toContain(`/assets/${file}`);
    for (const file of ['flow.js', 'sequence.js', 'layout.js', 'nested-layout.js', 'katex.js'])
      expect(shell).not.toContain(`/assets/${file}`);
    expect(shell).not.toContain('/assets/canvas.js');
    expect(shell).not.toContain('/assets/pdf.js');
  });
});
