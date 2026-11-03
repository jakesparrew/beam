#!/usr/bin/env node
// Writes docs/build/ownership.json from docs/plan/build-packages.json (BS-17), or checks a branch.
//   node scripts/build/ownership.mjs                      write ownership.json
//   node scripts/build/ownership.mjs --check <id> <base> [<ref>=HEAD]   list foreign paths, exit 1 if any
import { loadPlan, expandOwns, writeJson, OWNERSHIP, STATE, covers, alwaysAllowed, bs23Allowed, git, readJson } from './lib.mjs';

const plan = loadPlan();
const args = process.argv.slice(2);

if (args[0] === '--check') {
  const [, id, base, ref = 'HEAD'] = args;
  const own = readJson(OWNERSHIP, {});
  let owns = own[id]?.owns;
  // Fixer and split packages are not in the plan: their owns list lives in docs/build/state.json.
  if (!owns) owns = readJson(STATE, { packages: {} }).packages[id]?.owns;
  if (!owns) {
    const pkg = plan.packages.find(p => p.id === id);
    if (!pkg) { console.error(`unknown package ${id}`); process.exit(2); }
    owns = expandOwns(pkg);
  }
  const files = git('diff', '--name-only', `${base}...${ref}`).split('\n').filter(Boolean);
  const foreign = files.filter(p => !alwaysAllowed(id, p) && !owns.some(e => covers(e, p)) && !bs23Allowed(id, owns, p));
  if (foreign.length) {
    console.error(`ownership: ${id} changed ${foreign.length} path(s) it does not own:`);
    for (const f of foreign) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`ownership: ${id} ok (${files.length} changed paths)`);
  process.exit(0);
}

const out = {};
for (const p of plan.packages) out[p.id] = { module: p.module, wave: p.wave, release: p.release, owns: expandOwns(p) };
writeJson(OWNERSHIP, out);
console.log(`wrote ${Object.keys(out).length} packages to docs/build/ownership.json`);
