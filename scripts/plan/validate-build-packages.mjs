#!/usr/bin/env node
// Mechanical check of docs/plan/build-packages.json (rule 12 in docs/plan/03-build-order.md).
// Plain Node 22 ESM, no dependencies. Prints a report; exits 1 on any problem.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_PATH = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'docs/plan/build-packages.json');
const RELEASES = ['V1', 'R2', 'R3', 'R4'];
const ALLOWED_ROOTS = ['apps/', 'packages/', 'e2e/', 'scripts/', 'docs/', '.github/'];
const WAVE0_ROOT_FILES = new Set([
  'eslint.config.js', 'turbo.json', 'vercel.json', 'renovate.json', 'CLAUDE.md', '.prettierignore', '.nvmrc',
]);
// Real places of the files no package may own. A glob is refused when it overlaps one of these.
const FORBIDDEN_PLACES = [
  'package.json', 'apps/*/package.json', 'packages/*/package.json', 'pnpm-lock.yaml',
  'packages/db/migrations/**', 'apps/web/registry/*.generated.ts',
];
const PLACEHOLDER_PACKAGE = 'platform-P7';
const PLACEHOLDER = 'm';

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// ---------- path and glob helpers ----------
const isGlob = (p) => p.includes('*') || p.includes('{');

function expandBraces(p) {
  const open = p.indexOf('{');
  if (open < 0) return [p];
  let depth = 0;
  for (let i = open; i < p.length; i++) {
    if (p[i] === '{') depth++;
    else if (p[i] === '}' && --depth === 0) {
      const body = p.slice(open + 1, i);
      const parts = [];
      let d = 0, start = 0;
      for (let k = 0; k < body.length; k++) {
        if (body[k] === '{') d++;
        else if (body[k] === '}') d--;
        else if (body[k] === ',' && d === 0) { parts.push(body.slice(start, k)); start = k + 1; }
      }
      parts.push(body.slice(start));
      return parts.flatMap((part) => expandBraces(p.slice(0, open) + part + p.slice(i + 1)));
    }
  }
  return [p]; // unbalanced: treat literally
}

const escapeRe = (s) => s.replace(/[.+?^$()|[\]\\]/g, '\\$&');
const segRegex = (seg) => new RegExp('^' + seg.split('*').map(escapeRe).join('[^/]*') + '$');

// Can two single segments (each with only "*" wildcards) match one common name?
function segOverlap(a, b) {
  const aw = a.includes('*'), bw = b.includes('*');
  if (!aw && !bw) return a === b;
  if (!aw) return segRegex(b).test(a);
  if (!bw) return segRegex(a).test(b);
  // both have wildcards: compare literal head and tail, conservative
  const ah = a.slice(0, a.indexOf('*')), bh = b.slice(0, b.indexOf('*'));
  const at = a.slice(a.lastIndexOf('*') + 1), bt = b.slice(b.lastIndexOf('*') + 1);
  const headOk = ah.startsWith(bh) || bh.startsWith(ah);
  const tailOk = at.endsWith(bt) || bt.endsWith(at);
  return headOk && tailOk;
}

// Can the two patterns (brace-free) match a common path?
function patternOverlap(a, b) {
  const A = a.split('/'), B = b.split('/');
  const memo = new Map();
  const go = (i, j) => {
    const key = i + ',' + j;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (i < A.length && A[i] === '**') r = go(i + 1, j) || (j < B.length && go(i, j + 1));
    else if (j < B.length && B[j] === '**') r = go(i, j + 1) || (i < A.length && go(i + 1, j));
    else if (i === A.length || j === B.length) r = false;
    else r = segOverlap(A[i], B[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

// Overlap of two owned entries: same path, a glob reaching the other, or one literal being a folder of the other.
function ownsOverlap(a, b) {
  if (a === b) return true;
  if (!isGlob(a) && !isGlob(b)) return a.startsWith(b + '/') || b.startsWith(a + '/');
  for (const x of expandBraces(a)) {
    for (const y of expandBraces(b)) {
      if (patternOverlap(x, y)) return true;
      // a glob that reaches inside a folder the other names literally
      if (!isGlob(y) && patternOverlap(x, y + '/**')) return true;
      if (!isGlob(x) && patternOverlap(x + '/**', y)) return true;
    }
  }
  return false;
}

function forbiddenHit(p) {
  if (!isGlob(p)) {
    const base = p.split('/').pop();
    if (base === 'package.json' || base === 'pnpm-lock.yaml') return base;
    if (p.startsWith('packages/db/migrations/') || p === 'packages/db/migrations') return 'packages/db/migrations/**';
    if (/(^|\/)registry\/[^/]*\.generated\.ts$/.test(p)) return 'registry/*.generated.ts';
    return null;
  }
  for (const place of FORBIDDEN_PLACES) if (ownsOverlap(p, place)) return place;
  return null;
}

// platform-P7 owns "m" placeholder paths; the orchestrator expands them to the eleven module ids.
function expandPlaceholder(p, moduleIds) {
  const segs = p.split('/');
  const hit = segs.some((s) => s === PLACEHOLDER || s.split('.')[0] === PLACEHOLDER && s.includes('.'));
  if (!hit) return [p];
  return moduleIds.map((m) =>
    segs.map((s) => (s === PLACEHOLDER ? m : s.split('.')[0] === PLACEHOLDER && s.includes('.') ? m + s.slice(1) : s)).join('/'));
}

// ---------- load ----------
let plan;
try {
  plan = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
} catch (e) {
  console.error(`FAIL cannot read ${JSON_PATH}: ${e.message}`);
  process.exit(1);
}

// ---------- 1. shape ----------
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
const isInt = (v) => Number.isInteger(v) && v >= 0;
if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) err('shape: top level is not an object');
if (typeof plan.version !== 'number') err('shape: "version" must be a number');
if (typeof plan.integrationBranch !== 'string' || !plan.integrationBranch) err('shape: "integrationBranch" must be a non-empty string');
const waves = Array.isArray(plan.waves) ? plan.waves : (err('shape: "waves" must be an array'), []);
const pkgs = Array.isArray(plan.packages) ? plan.packages : (err('shape: "packages" must be an array'), []);

waves.forEach((w, i) => {
  const at = `wave[${i}]`;
  if (!isInt(w.wave)) err(`shape: ${at}.wave must be a whole number >= 0`);
  for (const k of ['name', 'goal']) if (typeof w[k] !== 'string' || !w[k]) err(`shape: ${at}.${k} must be a non-empty string`);
  if (!isStrArr(w.packages) || w.packages.length === 0) err(`shape: ${at}.packages must be a non-empty string array`);
  if (!isStrArr(w.gate) || w.gate.length === 0) err(`shape: ${at}.gate must be a non-empty string array`);
  if (typeof w.e2eCheckpoint !== 'boolean') err(`shape: ${at}.e2eCheckpoint must be a boolean`);
});
const PKG_STR = ['id', 'module', 'release', 'title', 'goal', 'spec', 'specSection'];
const PKG_ARR = ['dependsOn', 'owns', 'exposes', 'tests'];
pkgs.forEach((p, i) => {
  const at = `package[${i}]${p && p.id ? ` (${p.id})` : ''}`;
  for (const k of PKG_STR) if (typeof p[k] !== 'string' || !p[k]) err(`shape: ${at}.${k} must be a non-empty string`);
  for (const k of PKG_ARR) if (!Array.isArray(p[k]) || !p[k].every((x) => typeof x === 'string' && x)) err(`shape: ${at}.${k} must be a string array`);
  if (!isInt(p.wave)) err(`shape: ${at}.wave must be a whole number >= 0`);
  if (typeof p.estimateMinutes !== 'number' || !(p.estimateMinutes > 0)) err(`shape: ${at}.estimateMinutes must be a positive number`);
  if (typeof p.e2e !== 'boolean') err(`shape: ${at}.e2e must be a boolean`);
  if (!Array.isArray(p.owns) || p.owns.length === 0) err(`shape: ${at}.owns must not be empty`);
  if (typeof p.id === 'string' && typeof p.module === 'string' && !new RegExp(`^${p.module}-P\\d+[a-z]?$`).test(p.id))
    err(`shape: ${at} id must be "<module>-P<n>" with an optional letter, module "${p.module}"`);
  if (typeof p.specSection === 'string' && p.specSection !== '12') err(`shape: ${at}.specSection must be "12"`);
});
if (errors.length) report();

// ---------- 2. unique ids ----------
const byId = new Map();
for (const p of pkgs) {
  if (byId.has(p.id)) err(`ids: duplicate package id ${p.id}`);
  else byId.set(p.id, p);
}
const waveNums = new Set();
for (const w of waves) {
  if (waveNums.has(w.wave)) err(`waves: wave ${w.wave} is listed twice`);
  waveNums.add(w.wave);
}

// ---------- 3. wave lists match packages[].wave ----------
const listedIn = new Map();
for (const w of waves) {
  for (const id of w.packages) {
    if (listedIn.has(id)) err(`waves: ${id} is listed in wave ${listedIn.get(id)} and wave ${w.wave}`);
    listedIn.set(id, w.wave);
    const p = byId.get(id);
    if (!p) err(`waves: wave ${w.wave} lists unknown package ${id}`);
    else if (p.wave !== w.wave) err(`waves: wave ${w.wave} lists ${id}, but its "wave" is ${p.wave}`);
  }
}
for (const p of pkgs) {
  if (!listedIn.has(p.id)) err(`waves: ${p.id} (wave ${p.wave}) is in no wave list`);
  if (!waveNums.has(p.wave)) err(`waves: ${p.id} names wave ${p.wave}, which does not exist`);
}

// ---------- 4. dependsOn exists, sits in an earlier wave; releases ----------
const rank = (r) => RELEASES.indexOf(r);
for (const p of pkgs) {
  if (!RELEASES.includes(p.release)) err(`release: ${p.id} has release "${p.release}"; allowed ${RELEASES.join(', ')}`);
  const seen = new Set();
  for (const d of p.dependsOn) {
    if (seen.has(d)) warn(`dependsOn: ${p.id} lists ${d} twice`);
    seen.add(d);
    const q = byId.get(d);
    if (!q) { err(`dependsOn: ${p.id} depends on unknown package ${d}`); continue; }
    if (d === p.id) err(`dependsOn: ${p.id} depends on itself`);
    else if (!(q.wave < p.wave)) err(`dependsOn: ${p.id} (wave ${p.wave}) depends on ${d} (wave ${q.wave}); a dependency must be in an earlier wave`);
    if (p.release === 'V1' && q.release !== 'V1') err(`release: V1 package ${p.id} depends on ${q.release} package ${d}`);
    else if (rank(p.release) >= 0 && rank(q.release) > rank(p.release)) err(`release: ${p.release} package ${p.id} depends on later-release ${q.release} package ${d}`);
  }
}

// ---------- 5. no cycles ----------
{
  const state = new Map(); // 1 visiting, 2 done
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      if (state.get(d) === 1) err(`cycle: ${[...stack.slice(stack.indexOf(d)), d].join(' -> ')}`);
      else if (!state.get(d)) visit(d);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of byId.keys()) if (!state.get(id)) visit(id);
}

// ---------- 6. ownership: allowed folders, forbidden files, collisions within a wave ----------
const moduleIds = [...new Set(pkgs.map((p) => p.module))].filter((m) => m !== 'platform').sort();
if (moduleIds.length !== 11) err(`modules: expected 11 module ids besides platform for the "${PLACEHOLDER}" placeholder, found ${moduleIds.length} (${moduleIds.join(', ')})`);
const effectiveOwns = (p) => (p.id === PLACEHOLDER_PACKAGE ? p.owns.flatMap((o) => expandPlaceholder(o, moduleIds)) : p.owns);

for (const p of pkgs) {
  const dup = new Set();
  for (const o of p.owns) {
    if (dup.has(o)) warn(`owns: ${p.id} lists ${o} twice`);
    dup.add(o);
    if (o.startsWith('/') || o.startsWith('./') || o.split('/').includes('..') || o.endsWith('/') || o.includes('\\'))
      err(`owns: ${p.id} path "${o}" must be a clean relative path without "./", "..", a leading or a trailing slash`);
    const rootOk = ALLOWED_ROOTS.some((r) => o.startsWith(r));
    if (!rootOk && !(p.wave === 0 && WAVE0_ROOT_FILES.has(o)))
      err(`owns: ${p.id} path "${o}" is outside ${ALLOWED_ROOTS.join(' ')}${WAVE0_ROOT_FILES.has(o) ? ' (root tool files belong to the wave 0 package)' : ''}`);
    const hit = forbiddenHit(o);
    if (hit) err(`owns: ${p.id} path "${o}" reaches forbidden file ${hit}`);
  }
}

for (const w of waves) {
  const members = w.packages.map((id) => byId.get(id)).filter(Boolean);
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      const bo = effectiveOwns(b);
      for (const x of effectiveOwns(a)) {
        for (const y of bo) {
          if (ownsOverlap(x, y)) err(`collision: wave ${w.wave}: ${a.id} owns "${x}" and ${b.id} owns "${y}"`);
        }
      }
    }
  }
}
// The placeholder expansion must also not collide with platform-P7's own literal paths.
{
  const p7 = byId.get(PLACEHOLDER_PACKAGE);
  if (!p7) err(`placeholder: package ${PLACEHOLDER_PACKAGE} is missing`);
  else {
    const literal = p7.owns.filter((o) => expandPlaceholder(o, moduleIds).length === 1);
    for (const o of p7.owns) {
      if (expandPlaceholder(o, moduleIds).length === 1) continue;
      for (const e of expandPlaceholder(o, moduleIds))
        for (const l of literal) if (ownsOverlap(e, l)) err(`placeholder: ${PLACEHOLDER_PACKAGE} "${o}" expands to "${e}", which it also owns as "${l}"`);
    }
  }
}

// ---------- 6b. placement (platform PL-93): a file must sit where the framework or the owner reads it ----------
// Gaps G11, G12 and G15 of docs/plan/05-coverage.md: pages outside apps/web/app/, module code under packages/db/src/
// and an executor under the i18n message folder. Each of these builds and passes its own unit tests, but the route
// does not exist or the edit never reaches the real file.
const NEXT_SPECIAL = /^(page|layout|loading|error|not-found|global-error|route|template|default)\.(tsx|ts|jsx|js)$/;
const APP_EXTRA = /^(globals\.css|sitemap\.ts|robots\.ts|manifest\.ts|sw\.ts)$|\.test\.tsx?$/;
const DB_SRC_OK = /^packages\/db\/src\/((schema|seed|sql|testing)\/.+|index\.ts|enqueue\.ts|testing\.ts)$/;
const lastSeg = (o) => o.split('/').pop();
for (const p of pkgs) {
  for (const o of effectiveOwns(p)) {
    const base = lastSeg(o);
    if (o.startsWith('apps/web/') && !o.startsWith('apps/web/app/') && !isGlob(base) && NEXT_SPECIAL.test(base))
      err(`placement: ${p.id} owns "${o}"; a Next.js ${base} only works under apps/web/app/ (PL-93)`);
    if (o.startsWith('apps/web/app/') && !isGlob(base) && !NEXT_SPECIAL.test(base) && !APP_EXTRA.test(base))
      err(`placement: ${p.id} owns "${o}"; apps/web/app/ holds only route files, metadata files and their tests (PL-93)`);
    if (o.startsWith('packages/core/src/i18n/messages/') && !o.endsWith('.json'))
      err(`placement: ${p.id} owns "${o}"; the message folder holds only <locale>/<module>.json files (PL-93)`);
    if (o.startsWith('packages/db/src/') && !isGlob(o) && !DB_SRC_OK.test(o))
      err(`placement: ${p.id} owns "${o}"; packages/db/src/ holds only schema/, seed/, sql/, testing/ and the three root files (PL-93)`);
    const m = o.match(/^apps\/web\/modules\/([^/*{]+)\//);
    if (m && p.module !== 'platform' && m[1] !== p.module && lastSeg(o) !== 'api.ts')
      err(`placement: ${p.id} (module ${p.module}) owns "${o}" in module ${m[1]}; only platform and api.ts stubs cross module folders (PL-93)`);
    else if (m && p.module !== 'platform' && m[1] !== p.module)
      warn(`placement: ${p.id} (module ${p.module}) owns the api.ts of module ${m[1]}; check the cross-module decision that allows it`);
  }
}

// ---------- 6c. edit reach (platform PL-94): a later owner of a file must wait for the earlier owner ----------
// The same literal path owned in two waves means the later package edits what the earlier one created.
// The later package must reach the earlier one through dependsOn, or it may run before the file exists.
{
  const closure = new Map();
  const reach = (id) => {
    if (closure.has(id)) return closure.get(id);
    const s = new Set();
    closure.set(id, s);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      s.add(d);
      for (const x of reach(d)) s.add(x);
    }
    return s;
  };
  const owners = new Map();
  for (const p of pkgs) for (const o of effectiveOwns(p)) {
    if (isGlob(o)) continue;
    if (!owners.has(o)) owners.set(o, []);
    owners.get(o).push(p);
  }
  for (const [o, list] of owners) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.wave - b.wave);
    const first = sorted[0];
    for (const q of sorted.slice(1)) {
      if (q.id === first.id || q.wave === first.wave) continue; // same wave is a collision, reported in section 6
      if (!reach(q.id).has(first.id))
        err(`reach: ${q.id} (wave ${q.wave}) edits "${o}", created by ${first.id} (wave ${first.wave}), but does not depend on it (PL-94)`);
    }
  }
}

// ---------- 7. spec files and section 12 ----------
const specText = new Map();
for (const p of pkgs) {
  if (specText.has(p.spec)) continue;
  const abs = join(ROOT, p.spec);
  if (!existsSync(abs)) { err(`spec: ${p.id} names missing spec ${p.spec}`); specText.set(p.spec, null); continue; }
  specText.set(p.spec, readFileSync(abs, 'utf8'));
  if (p.spec !== `docs/plan/modules/${p.module}.md`) warn(`spec: ${p.id} uses ${p.spec}, not docs/plan/modules/${p.module}.md`);
}

function section12(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## 12\b/.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, k) => k > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end);
}

const allModules = [...moduleIds, 'platform'];
const mentionRe = new RegExp(`\\b(${allModules.join('|')})-P\\d+[a-z]?\\b`, 'g');
const splitParents = new Set();
const headingPkgs = new Map(); // id -> {release, spec}
for (const m of allModules) {
  const spec = `docs/plan/modules/${m}.md`;
  const text = specText.get(spec) ?? (existsSync(join(ROOT, spec)) ? readFileSync(join(ROOT, spec), 'utf8') : null);
  if (text == null) { err(`spec: module ${m} has no spec ${spec}`); continue; }
  specText.set(spec, text);
  const sec = section12(text);
  if (!sec) { err(`spec: ${spec} has no "## 12" section`); continue; }
  for (const line of sec) {
    const h = line.match(new RegExp(`^### (${m}-P\\d+[a-z]?)\\b(.*)$`));
    if (!h) continue;
    const [, id, rest] = h;
    if (/split into/i.test(rest)) { splitParents.add(id); continue; }
    const rel = rest.match(/\b(V1|R2|R3|R4)\b/);
    if (headingPkgs.has(id)) err(`spec: ${spec} has two section 12 headings for ${id}`);
    headingPkgs.set(id, { release: rel ? rel[1] : null, spec });
    if (!rel) err(`spec: ${spec} heading ${id} names no release (V1, R2, R3 or R4)`);
  }
}
for (const [id, h] of headingPkgs) {
  const p = byId.get(id);
  if (!p) err(`spec: ${h.spec} section 12 has ${id}, which is not in build-packages.json`);
  else {
    if (h.release && p.release !== h.release) err(`spec: ${id} is ${h.release} in ${h.spec} but ${p.release} in the JSON`);
    if (p.spec !== h.spec) err(`spec: ${id} heading sits in ${h.spec} but the JSON names ${p.spec}`);
  }
}
for (const p of pkgs) {
  if (splitParents.has(p.id)) err(`spec: ${p.id} is a split parent in its spec and must not be in the JSON`);
  else if (!headingPkgs.has(p.id)) err(`spec: ${p.id} has no "### ${p.id}" heading in section 12 of docs/plan/modules/${p.module}.md`);
}
for (const m of allModules) {
  const spec = `docs/plan/modules/${m}.md`;
  const sec = specText.get(spec) && section12(specText.get(spec));
  if (!sec) continue;
  const bad = new Set();
  for (const line of sec) for (const [id] of line.matchAll(mentionRe)) if (!byId.has(id) && !splitParents.has(id)) bad.add(id);
  for (const id of bad) err(`spec: section 12 of ${spec} mentions ${id}, which is neither a JSON package nor a split parent`);
}

report();

function report() {
  console.log(`build-packages.json: ${pkgs.length} packages, ${waves.length} waves`);
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`FAIL  ${e}`);
  console.log(errors.length ? `\n${errors.length} problem(s), ${warnings.length} warning(s)` : `\nOK, ${warnings.length} warning(s)`);
  process.exit(errors.length ? 1 : 0);
}
