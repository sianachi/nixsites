// Picks the xunit query filters for one shard of the integration suite (CI backend).
//
// scripts/ci/integration-shards.json lists, per shard, what it is expected to run, for balance:
// "Namespace.Class" (every test in the class) or "Namespace.Class#Method" (one method, for the few
// classes too big for one shard; a theory's rows stay together). Shards 1..K-1 run exactly what
// they list. Shard K runs everything the other shards do not name, so a class or method added
// without touching the file lands in shard K instead of nowhere. Every shard is therefore a slice
// of one partition by construction; the guard job in ci-backend.yml re-proves it from the test
// lists the shards print.
//
//   node scripts/ci/integration-shard.mjs <shard 1..K>   prints one --filter-query pair per query
//   node scripts/ci/integration-shard.mjs --check        fails on an entry listed twice
//
// SKIP_PLAN_EVIDENCE=1 leaves out the tests marked Category=PlanEvidence.
import fs from 'node:fs';

const shards = JSON.parse(
  fs.readFileSync(new URL('./integration-shards.json', import.meta.url), 'utf8'),
);
const k = shards.length;
// A trait filter closes the query, after a trailing slash.
const trait = process.env.SKIP_PLAN_EVIDENCE === '1' ? '/[Category!=PlanEvidence]' : '';

const seen = new Map();
for (const [i, entries] of shards.entries()) {
  for (const e of entries) {
    if (seen.has(e)) {
      console.error(`${e} is listed in shard ${seen.get(e) + 1} and shard ${i + 1}`);
      process.exit(1);
    }
    seen.set(e, i);
  }
}

// "A.B.Class" -> [namespace, class]; "A.B.Class#Method" -> [namespace, class, method].
function parts(entry) {
  const [type, method] = entry.split('#');
  const dot = type.lastIndexOf('.');
  return [type.slice(0, dot), type.slice(dot + 1), method];
}
const query = (ns, cls, method) => `/*/${ns}/${cls}/${method ?? '*'}${trait}`;

const arg = process.argv[2];
if (arg === '--check') {
  console.log(`${seen.size} entries in ${k} shards`);
} else {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > k) {
    console.error(`shard must be 1..${k}`);
    process.exit(1);
  }
  const out = [];
  if (n < k) {
    for (const e of shards[n - 1]) out.push(query(...parts(e)));
  } else {
    // Whole classes named elsewhere, and classes split by method, drop out of the first query;
    // a split class's other methods come back through one query of their own.
    const named = new Set();
    const split = new Map();
    for (const [e, i] of seen) {
      if (i === k - 1) continue;
      const [ns, cls, method] = parts(e);
      if (method === undefined) named.add(cls);
      else split.set(`${ns}.${cls}`, [...(split.get(`${ns}.${cls}`) ?? []), method]);
    }
    const excluded = [...named, ...[...split.keys()].map((c) => c.slice(c.lastIndexOf('.') + 1))];
    out.push(`/*/*/${excluded.map((c) => `(!${c})`).join('&')}/*${trait}`);
    for (const [c, methods] of split) {
      const dot = c.lastIndexOf('.');
      out.push(
        `/*/${c.slice(0, dot)}/${c.slice(dot + 1)}/${methods.map((m) => `(!${m})`).join('&')}${trait}`,
      );
    }
  }
  for (const q of out) console.log(`--filter-query\n${q}`);
}
