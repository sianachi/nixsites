// Proves the integration shards are a partition of the unsplit suite: every test the full listing
// names is listed by exactly one shard, and no shard lists anything else.
//   node scripts/ci/check-shard-partition.mjs <dir>   (dir holds all.txt and shard-<n>.txt, as
//   printed by `dotnet test --list-tests`)
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const tests = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.trim());
const count = (names) => names.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map());

const all = count(tests(path.join(dir, 'all.txt')));
const union = new Map();
let total = 0;
for (const f of fs.readdirSync(dir).filter((f) => /^shard-\d+\.txt$/.test(f))) {
  const names = tests(path.join(dir, f));
  total += names.length;
  console.log(`${f}: ${names.length} tests`);
  for (const [n, c] of count(names)) union.set(n, (union.get(n) ?? 0) + c);
}
const allTotal = [...all.values()].reduce((a, b) => a + b, 0);
console.log(`unsplit: ${allTotal} tests, shards together: ${total}`);
const bad = [...new Set([...all.keys(), ...union.keys()])].filter((n) => all.get(n) !== union.get(n));
if (bad.length > 0 || allTotal === 0) {
  console.error(`Shards are not a partition of the suite (${bad.length} tests differ):`);
  for (const n of bad.slice(0, 40)) console.error(`  ${n}: unsplit ${all.get(n) ?? 0}, shards ${union.get(n) ?? 0}`);
  process.exit(1);
}
console.log('Shards partition the suite exactly.');
