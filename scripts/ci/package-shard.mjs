// Splits the workspace packages across the shards of the frontend package jobs (lint, typecheck
// and unit tests run per package). Every shard computes the same assignment from the live
// workspace list, so each package lands in exactly one shard and a package added later is picked
// up with the default weight, with no list to forget to update.
//
//   node scripts/ci/package-shard.mjs <shard 1..N> <N>   one pnpm --filter argument per line
//   node scripts/ci/package-shard.mjs --check <N>        proves the shards partition the workspace
//
// package-weights.json holds rough seconds per package (lint + typecheck + tests) for balance only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const weights = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/ci/package-weights.json'), 'utf8'),
);
const listed = JSON.parse(
  execFileSync('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
);
const packages = listed
  .map((p) => path.relative(root, p.path))
  .filter((p) => p !== '')
  .sort();

function assign(n) {
  const load = Array.from({ length: n }, () => 0);
  const shards = Array.from({ length: n }, () => []);
  const byWeight = [...packages].sort(
    (a, b) => (weights[b] ?? 10) - (weights[a] ?? 10) || a.localeCompare(b),
  );
  for (const p of byWeight) {
    const i = load.indexOf(Math.min(...load));
    shards[i].push(p);
    load[i] += weights[p] ?? 10;
  }
  return shards;
}

if (process.argv[2] === '--check') {
  const n = Number(process.argv[3]);
  const all = assign(n).flat().sort();
  const ok = all.length === packages.length && all.every((p, i) => p === packages[i]);
  console.log(`${packages.length} packages, ${all.length} assigned across ${n} shards`);
  if (!ok) process.exit(1);
} else {
  const [i, n] = [Number(process.argv[2]), Number(process.argv[3])];
  if (!(i >= 1 && i <= n)) {
    console.error('usage: package-shard.mjs <shard> <shards> | --check <shards>');
    process.exit(1);
  }
  for (const p of assign(n)[i - 1]) console.log(`--filter\n./${p}`);
}
