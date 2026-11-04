// Resolves merge conflicts in message catalogues (OD-17). Catalogues are nested JSON objects of
// strings; two packages that each add or change different keys of one catalogue conflict in git
// only because their lines are adjacent. This merges each conflicted catalogue key by key from
// the three stages: a key changed on one side takes that side's value, a key changed identically
// on both sides is kept, and a key changed differently on both sides is a real conflict (exit 1,
// nothing written). Key order: ours, then theirs' new keys. Run during a conflicted merge with
// the conflicted catalogue paths as arguments.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const CATALOGUE = /^packages\/core\/src\/i18n\/messages\/[^/]+\/[^/]+\.json$/;

const stage = (n, file) => {
  try {
    return JSON.parse(execFileSync('git', ['show', `:${n}:${file}`], { encoding: 'utf8' }));
  } catch {
    return undefined;
  }
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function merge3(base, ours, theirs, at, conflicts) {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  if (isObj(ours) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of [...Object.keys(ours), ...Object.keys(theirs).filter((k) => !(k in ours))]) {
      const v = merge3(b[k], ours[k], theirs[k], `${at}.${k}`, conflicts);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  conflicts.push(at.slice(1));
  return ours;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const files = process.argv.slice(2);
  const results = [];
  for (const file of files) {
    if (!CATALOGUE.test(file)) { console.error(`not a catalogue: ${file}`); process.exit(1); }
    const conflicts = [];
    const merged = merge3(stage(1, file), stage(2, file), stage(3, file), '', conflicts);
    if (conflicts.length) { console.error(`${file}: keys changed on both sides: ${conflicts.join(', ')}`); process.exit(1); }
    results.push([file, merged]);
  }
  for (const [file, merged] of results) fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  console.log(`catalogues merged key by key: ${files.length}`);
}
