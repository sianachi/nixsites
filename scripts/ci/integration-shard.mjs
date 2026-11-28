// Picks the xunit class filters for one shard of the integration suite (CI backend).
//
// scripts/ci/integration-shards.json lists, per shard, the test classes it is expected to run, for
// balance. Shards 1..K-1 run exactly their listed classes (--filter-class); shard K runs everything
// the other shards do not name (--filter-not-class), so a class added without touching the file
// lands in shard K instead of nowhere. Every shard is therefore a slice of one partition by
// construction; the guard job in ci-backend.yml re-proves it from the test lists the shards print.
//
//   node scripts/ci/integration-shard.mjs <shard 1..K>   prints one runner argument per line
//   node scripts/ci/integration-shard.mjs --check        fails on a class listed twice
import fs from 'node:fs';

const shards = JSON.parse(
  fs.readFileSync(new URL('./integration-shards.json', import.meta.url), 'utf8'),
);
const k = shards.length;

const seen = new Map();
for (const [i, classes] of shards.entries()) {
  for (const c of classes) {
    if (seen.has(c)) {
      console.error(`${c} is listed in shard ${seen.get(c) + 1} and shard ${i + 1}`);
      process.exit(1);
    }
    seen.set(c, i);
  }
}

const arg = process.argv[2];
if (arg === '--check') {
  console.log(`${seen.size} classes in ${k} shards`);
} else {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > k) {
    console.error(`shard must be 1..${k}`);
    process.exit(1);
  }
  if (n < k) {
    for (const c of shards[n - 1]) console.log(`--filter-class\n${c}`);
  } else {
    for (const [c, i] of seen) if (i < k - 1) console.log(`--filter-not-class\n${c}`);
  }
}
