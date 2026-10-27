// Vite + Vitest configuration for @nix/web.
//
// Tailwind CSS v4 is CSS-first: there is no tailwind.config.js and no
// PostCSS chain. The @tailwindcss/vite plugin compiles src/app.css, which
// imports Tailwind and then the @nix/design-tokens @theme sheet, so every
// Industry token becomes a utility class.
//
// Content detection is automatic for this app's own source, but not sufficient
// on its own - see the @source directive in src/app.css, which says why.
//
// The test block runs the same source through jsdom. CSS is not processed
// during tests - component tests assert behaviour and roles, never computed
// styles, so compiling Tailwind for them would only cost time.
import { createHash } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin, Rollup } from 'vite';
import { defineConfig } from 'vitest/config';

const excalidrawFontUrlPrefix = '/excalidraw-assets/fonts/';
const requireFromViteConfig = createRequire(import.meta.url);
const excalidrawFontSourceDirectory = fileURLToPath(
  new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url),
);
// Resolve through Excalidraw's real package entry: pnpm keeps transitive dependencies beside
// that package, rather than below the workspace's node_modules symlink.
const requireFromExcalidraw = createRequire(
  requireFromViteConfig.resolve('@excalidraw/excalidraw'),
);
const roughjsEntry = requireFromExcalidraw.resolve('roughjs/bin/rough.js');

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** PDF support files stay on this origin and are fetched only when a page needs them. */
function pdfSupportAssets(): Plugin {
  const sources = {
    fonts: fileURLToPath(new URL('./node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
    cmaps: fileURLToPath(new URL('./node_modules/pdfjs-dist/cmaps/', import.meta.url)),
  };
  let outputDirectory: string;
  return {
    name: 'nix:pdf-support-assets',
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://nix.local').pathname;
        const match = /^\/pdf-assets\/(fonts|cmaps)\/([A-Za-z0-9_-]+\.(?:pfb|ttf|bcmap))$/u.exec(
          path,
        );
        const filename = match?.[2];
        if (filename === undefined) {
          next();
          return;
        }
        const directory = match?.[1] === 'fonts' ? sources.fonts : sources.cmaps;
        void readFile(resolve(directory, filename))
          .then((data) => {
            response.setHeader('Content-Type', 'application/octet-stream');
            response.end(data);
          })
          .catch((error: unknown) => {
            if (hasErrorCode(error, 'ENOENT')) next();
            else next(error);
          });
      });
    },
    async writeBundle() {
      for (const [name, source] of Object.entries(sources)) {
        await cp(source, resolve(outputDirectory, 'pdf-assets', name), { recursive: true });
      }
    },
  };
}

function excalidrawFontAssets(): Plugin {
  let buildOutputDirectory: string | undefined;

  return {
    name: 'nix:excalidraw-font-assets',
    configResolved(config) {
      buildOutputDirectory = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url;
        if (requestUrl === undefined) {
          next();
          return;
        }

        let pathname: string;
        try {
          pathname = new URL(requestUrl, 'http://nix.local').pathname;
        } catch {
          response.statusCode = 400;
          response.end();
          return;
        }

        if (!pathname.startsWith(excalidrawFontUrlPrefix)) {
          next();
          return;
        }

        let requestedRelativePath: string;
        try {
          requestedRelativePath = decodeURIComponent(
            pathname.slice(excalidrawFontUrlPrefix.length),
          );
        } catch {
          response.statusCode = 400;
          response.end();
          return;
        }

        const requestedFile = resolve(excalidrawFontSourceDirectory, requestedRelativePath);
        const sourceRelativePath = relative(excalidrawFontSourceDirectory, requestedFile);
        const isContainedFont =
          sourceRelativePath.endsWith('.woff2') &&
          sourceRelativePath !== '..' &&
          !sourceRelativePath.startsWith(`..${sep}`) &&
          !isAbsolute(sourceRelativePath);

        if (!isContainedFont) {
          next();
          return;
        }

        void readFile(requestedFile)
          .then((font) => {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'font/woff2');
            response.end(font);
          })
          .catch((error: unknown) => {
            if (hasErrorCode(error, 'ENOENT')) {
              next();
              return;
            }
            next(error);
          });
      });
    },
    async writeBundle() {
      if (buildOutputDirectory === undefined) {
        throw new Error('Vite did not resolve an output directory for Excalidraw font assets.');
      }

      await cp(
        excalidrawFontSourceDirectory,
        resolve(buildOutputDirectory, 'excalidraw-assets/fonts'),
        { recursive: true },
      );
    },
  };
}

/**
 * The scripts and styles the application needs before it can paint: the entry chunk, the chunk it
 * loads the application from, and everything those import statically. Feature chunks are cached on
 * first use.
 */
export function startupGraph(bundle: Rollup.OutputBundle): {
  readonly entry: string;
  readonly startup: readonly string[];
} {
  const chunks = Object.values(bundle).filter(
    (output): output is Rollup.OutputChunk => output.type === 'chunk',
  );
  const entry = chunks.find((chunk) => chunk.isEntry);
  if (!entry) throw new Error('The application entry chunk is missing.');
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const files = new Set<string>();
  const visit = (fileName: string): void => {
    if (files.has(fileName)) return;
    files.add(fileName);
    const chunk = byName.get(fileName);
    if (!chunk) return;
    for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(css);
    for (const asset of chunk.viteMetadata?.importedAssets ?? []) files.add(asset);
    for (const imported of chunk.imports) visit(imported);
  };
  visit(entry.fileName);
  // main.tsx loads the application with one dynamic import after its boot concerns run; that
  // chunk is part of every launch, unlike the feature chunks the application itself loads lazily.
  // Exactly one: a second dynamic import in the entry would silently join every install.
  if (entry.dynamicImports.length !== 1) {
    throw new Error(
      `The entry should load the application with one dynamic import; it has ${String(entry.dynamicImports.length)}. Update startupGraph if that is intended.`,
    );
  }
  for (const dynamic of entry.dynamicImports) visit(dynamic);
  return { entry: `/${entry.fileName}`, startup: [...files].map((file) => `/${file}`) };
}

function replaceExactlyOnce(source: string, pattern: string | RegExp, replacement: string): string {
  const matches =
    typeof pattern === 'string'
      ? source.split(pattern).length - 1
      : [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].length;
  if (matches !== 1)
    throw new Error(`Expected one service worker placeholder for ${String(pattern)}.`);
  return source.replace(pattern, replacement);
}

const fallbackCspMeta =
  /\s*<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]+"\s+data-nix-csp-fallback\s*\/>/u;

export function parseObjectStorePublicOrigin(value: string): string {
  if (value === '' || value !== value.trim() || value.length > 2_048) {
    throw new Error('NIX_OBJECT_STORE_PUBLIC_ORIGIN must be one bounded HTTP(S) origin.');
  }

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('NIX_OBJECT_STORE_PUBLIC_ORIGIN must be an absolute HTTP(S) origin.');
  }

  const loopback =
    origin.hostname === 'localhost' ||
    origin.hostname === '127.0.0.1' ||
    origin.hostname === '[::1]';
  if (
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    throw new Error(
      'NIX_OBJECT_STORE_PUBLIC_ORIGIN must be HTTPS outside loopback development and must not contain credentials, a path, query, or fragment.',
    );
  }

  return origin.origin;
}

export function contentSecurityPolicy(objectStorePublicOrigin: string): string {
  const origin = parseObjectStorePublicOrigin(objectStorePublicOrigin);
  return `default-src 'self'; script-src 'self' 'sha256-qzYt63qWJpMm2Kfb4Wr8UDbUtUgweR4Gv4rs133db2w='; style-src 'self' 'unsafe-inline'; img-src 'self' http: https: data: blob:; font-src 'self'; connect-src 'self' ${origin}; media-src 'self' blob: ${origin}; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`;
}

const objectStorePublicOrigin = parseObjectStorePublicOrigin(
  process.env.NIX_OBJECT_STORE_PUBLIC_ORIGIN ?? 'http://localhost:7070',
);
const apiOrigin =
  process.env.NIX_API_ORIGIN ?? `http://localhost:${process.env.NIX_API_PORT ?? '5014'}`;
const collaborationOrigin =
  process.env.NIX_COLLAB_ORIGIN ?? `http://localhost:${process.env.NIX_COLLAB_PORT ?? '8100'}`;
const browserPolicy = contentSecurityPolicy(objectStorePublicOrigin);
// The React plugin injects a development-only inline preamble. Production and static preview keep
// the hash-only policy; the dev server is local tooling and must permit that preamble to run.
const developmentBrowserPolicy = browserPolicy.replace(
  /script-src 'self' [^;]+/u,
  "script-src 'self' 'unsafe-inline'",
);

export default defineConfig({
  optimizeDeps: {
    // Canvas loads lazily. Optimize its React dependency with the initial application graph:
    // re-optimizing on first open changes shared module URLs, and hmr: false cannot reload the
    // mounted application to replace its existing React and Yjs instances.
    include: ['@excalidraw/excalidraw'],
  },
  // Excalidraw's published bundle imports roughjs without its file extension. Vite's browser
  // resolver accepts that path, while Node 25 (used by Vitest) does not.
  resolve: {
    alias: {
      'roughjs/bin/rough': roughjsEntry,
    },
  },
  server: {
    port: Number(process.env.NIX_WEB_PORT ?? 5173),
    headers: { 'Content-Security-Policy': developmentBrowserPolicy },
    // The app consumes workspace packages as source. In the local browser this can cause the
    // React Refresh wrapper for a package module to run before its HTML preamble, preventing
    // React from mounting at all. Reloading is a reliable development fallback; it leaves the
    // production bundle untouched.
    hmr: false,
    // The API is a different origin in development. Proxying keeps the browser same-origin, so
    // there is no CORS preflight on every request and no cookie/credential surprises - the token
    // travels in the Authorization header either way, but same-origin is the shape production has.
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
      },
      '/auth': {
        target: apiOrigin,
        changeOrigin: true,
      },

      // The collaboration service is a third origin, and it holds the document bodies. The
      // prefix is stripped because the service's own routes are '/documents/...' - it does not
      // know or care that the browser reaches it under a path.
      '/collab': {
        target: collaborationOrigin,
        changeOrigin: true,
        // The editor reaches the service over a WebSocket; without this the proxy
        // answers the upgrade itself and the socket never opens.
        ws: true,
        rewrite: (path: string) => path.replace(/^\/collab/, ''),
      },
    },
  },

  preview: {
    headers: { 'Content-Security-Policy': browserPolicy },
  },

  plugins: [
    {
      name: 'nix-pwa-assets',
      async generateBundle(_options, bundle) {
        const assets = Object.keys(bundle)
          .filter((name) => /^assets\/.*\.(?:js|css|woff2)$/.test(name))
          .map((name) => `/${name}`);
        const offline = await readFile(new URL('./public/offline.html', import.meta.url), 'utf8');
        const worker = await readFile(
          new URL('./public/service-worker.js', import.meta.url),
          'utf8',
        );
        const version = createHash('sha256')
          .update(JSON.stringify(assets))
          .update(worker)
          .update(offline)
          .digest('hex')
          .slice(0, 16);
        const offlineCss = assets.find((name) => /^\/assets\/index-.*\.css$/.test(name));
        if (!offlineCss) throw new Error('The offline screen stylesheet is missing.');
        const { entry, startup } = startupGraph(bundle);
        const baseShellFiles = ['/offline.html', '/nix-icon-192.png', '/nix-icon-512.png'];
        this.emitFile({
          type: 'asset',
          fileName: 'offline.html',
          source: offline.replace('/src/app.css', offlineCss),
        });
        // Each placeholder in the source worker, and what this build puts in its place.
        const placeholders: readonly (readonly [string | RegExp, string])[] = [
          [
            "const VERSION = 'nix-pwa-dev';",
            `const VERSION = ${JSON.stringify(`nix-pwa-${version}`)};`,
          ],
          [
            /const SHELL_ASSETS = \[.*?\];/su,
            `const SHELL_ASSETS = ${JSON.stringify([...new Set([...baseShellFiles, '/index.html', offlineCss, ...startup])])};`,
          ],
          [
            /const ASSETS = \[.*?\];/su,
            `const ASSETS = ${JSON.stringify([...new Set([...baseShellFiles, ...assets, ...startup])])};`,
          ],
          ['const SHELL_ENTRY = null;', `const SHELL_ENTRY = ${JSON.stringify(entry)};`],
        ];
        this.emitFile({
          type: 'asset',
          fileName: 'service-worker.js',
          source: placeholders.reduce(
            (source, [pattern, replacement]) => replaceExactlyOnce(source, pattern, replacement),
            worker,
          ),
        });
      },
    },
    excalidrawFontAssets(),
    pdfSupportAssets(),
    {
      name: 'nix-configured-content-security-policy',
      enforce: 'pre',
      transformIndexHtml(html) {
        const transformed = html.replace(fallbackCspMeta, '');
        if (transformed === html) {
          throw new Error('The marked fallback Content-Security-Policy meta tag is missing.');
        }
        return transformed;
      },
    },
    react(),
    tailwindcss(),
  ],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Node 25 defines a global `localStorage` of its own, which has no methods without a storage
    // file and hides jsdom's; tests calling `localStorage.clear()` then fail. Node 22 (CI) accepts
    // the flag and already leaves it off.
    poolOptions: {
      forks: { execArgv: ['--no-experimental-webstorage'] },
      threads: { execArgv: ['--no-experimental-webstorage'] },
    },
    server: {
      deps: { inline: ['@excalidraw/excalidraw', 'roughjs'] },
    },

    // Not the 5000 default, and please do not "tidy" it back.
    //
    // Reproduce before changing this: `pnpm --filter @nix/web test
    // --reporter=json`, full 47-file suite in parallel, otherwise-idle 10-core
    // machine. The numbers below are from exactly that.
    //
    // The worst case used to be 'counts February 2028 as a leap February' in
    // src/tests/views/calendar/calendar-view.test.tsx. Worst figure on record for it: 4849ms,
    // 97% of the 5000 default, idle. Re-measured on the same machine it came
    // back at 4041ms, 81% - and that spread between two idle runs of the same
    // test is itself the argument, because a CI runner is never the better of
    // the two. It was not irreducible render cost: the test reached
    // February 2028 by clicking "Next month" 23 times, so 23 sequential
    // userEvent round trips paid for navigation that was scaffolding rather
    // than the behaviour under test. Those loops are gone - the two tests that
    // had them now name their month on the fake clock the suite already runs,
    // and the second-worst offender kept its single boundary-crossing click
    // because that click is the claim.
    //
    // Those two tests now cost 122ms and 210ms. What remains at the top is
    // ordinary per-test page render into jsdom under parallel contention,
    // peaking at 1545ms ('says which week it is showing, naming both months
    // when it straddles them' in calendar-modes.test.tsx, which keeps its two
    // clicks because a straddling week cannot be reached in one). Idle that is
    // 31% of the default - but idle is not what CI gives you, and the figures
    // above show the same test swinging by ~20% between two idle runs. 15s
    // keeps headroom for that without letting a genuinely hung test sit for a
    // minute. The failure it prevents is the expensive kind: a timeout on a
    // busy runner is indistinguishable from a real regression until someone
    // reruns it alone.
    //
    // Node-environment packages do not need this. packages/ui's component
    // tests no longer peak at 703ms idle (first-in-file tests now take about
    // 2s), so it carries the same value with its own measurements.
    testTimeout: 15_000,
  },
});
