// Writes ios/App/App/Info.generated.plist (the plist Xcode builds with): the tracked Info.plist,
// plus WKAppBoundDomains from app-bound-domains.txt when that file exists. WKWebView runs service
// workers, and so the web app's offline shell, only for app-bound domains. The list lives in a
// gitignored file because it names the servers this build is for.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The bound domains a list file names: `localhost` (the picker) first, at most 10 in all. */
export function boundDomains(text) {
  const domains = text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim().toLowerCase())
    .filter((line) => line !== '');
  for (const domain of domains)
    if (!/^[a-z\d]([a-z\d-]*[a-z\d])?(\.[a-z\d]([a-z\d-]*[a-z\d])?)*$/.test(domain))
      throw new Error(`Not a host name: ${domain} (one host per line, no scheme or port)`);
  const all = [...new Set(['localhost', ...domains])];
  if (all.length > 10) throw new Error(`iOS allows 10 app-bound domains, this lists ${all.length}`);
  return all;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('..', import.meta.url);
  const list = new URL('app-bound-domains.txt', root);
  const source = fileURLToPath(new URL('ios/App/App/Info.plist', root));
  const target = fileURLToPath(new URL('ios/App/App/Info.generated.plist', root));
  copyFileSync(source, target);
  if (existsSync(list)) {
    const domains = boundDomains(readFileSync(list, 'utf8'));
    execFileSync('plutil', [
      '-insert',
      'WKAppBoundDomains',
      '-json',
      JSON.stringify(domains),
      target,
    ]);
    console.warn(`App-bound (offline-capable): ${domains.join(', ')}`);
  } else {
    console.warn('No app-bound-domains.txt: the app opens any server, online only.');
  }
}
