// Shared helpers for the build-session scripts (orchestrator-owned, BS-2).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const PLAN = path.join(ROOT, 'docs/plan/build-packages.json');
export const OWNERSHIP = path.join(ROOT, 'docs/build/ownership.json');
export const STATE = path.join(ROOT, 'docs/build/state.json');
export const MODULE_IDS = ['crm', 'booking', 'commerce', 'credits', 'finance', 'forms', 'email', 'automation', 'ops', 'site', 'webinar'];

export const readJson = (p, fallback) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
export const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
export const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

export function loadPlan() { return readJson(PLAN); }

// Normalise one owns entry: strip spaces inside braces, folder "x/" -> "x/**".
export function normaliseEntry(e) {
  let s = e.trim().replace(/\{([^}]*)\}/g, (_, inner) => '{' + inner.split(',').map(x => x.trim()).join(',') + '}');
  if (s.endsWith('/')) s += '**';
  return s;
}

// Expand the platform-P7 placeholder module "m" (amendment A3) into the eleven module ids.
export function expandOwns(pkg) {
  const out = [];
  for (const raw of pkg.owns || []) {
    if (pkg.id === 'platform-P1' && raw === 'docs/build/ownership.json') continue; // A1
    const e = normaliseEntry(raw);
    const isPlaceholder = /(^|\/)m(\/|\.ts$|\.json$|\.views\.ts$)/.test(e) && pkg.id === 'platform-P7';
    if (isPlaceholder) {
      for (const m of MODULE_IDS) out.push(e.replace(/(^|\/)m(?=\/|\.ts$|\.json$|\.views\.ts$)/, `$1${m}`));
    } else out.push(e);
  }
  return [...new Set(out)];
}

const GLOB_CHARS = /[*?{]/;
const escapeLiteralBrackets = s => s.replace(/[[\]]/g, c => (c === '[' ? '[[]' : '[]]'));

// True when the repository path p is covered by the owns entry e.
export function covers(e, p) {
  if (!GLOB_CHARS.test(e)) return e === p;
  // Escape [ ] ( ) that are part of route folder names, then glob-match.
  return path.matchesGlob(p, escapeLiteralBrackets(e));
}

// Static prefix of an entry (up to the first glob character), for overlap tests.
function staticPrefix(e) {
  const i = e.search(GLOB_CHARS);
  return i === -1 ? e : e.slice(0, i);
}

// Conservative: true when two owns entries could name the same file.
export function entriesOverlap(a, b) {
  if (a === b) return true;
  const ga = GLOB_CHARS.test(a), gb = GLOB_CHARS.test(b);
  if (!ga && !gb) return false;
  if (!ga) return covers(b, a);
  if (!gb) return covers(a, b);
  const pa = staticPrefix(a), pb = staticPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export function ownsOverlap(listA, listB) {
  for (const a of listA) for (const b of listB) if (entriesOverlap(a, b)) return [a, b];
  return null;
}

// Paths always allowed in any package branch.
export function alwaysAllowed(id, p) {
  if (/\.generated\.ts$/.test(p)) return true;
  if (p === 'packages/db/src/schema/index.ts') return true;
  if (p === `docs/build/dependency-requests/${id}.md`) return true;
  // OD-16: fixers remove their own known-red lines; merge.sh merges the file as a set.
  if (p === 'docs/build/known-red.txt' && id.startsWith('fix-')) return true;
  return false;
}

// BS-23: a test file whose basename starts with the package id in lower case,
// inside a folder the package owns (the folder of an owned path or glob prefix).
export function bs23Allowed(id, owns, p) {
  const lower = id.toLowerCase();
  const base = path.posix.basename(p);
  const inFixtureDir = p.split('/').some(seg => seg === lower);
  if (!base.startsWith(lower) && !inFixtureDir) return false;
  const dir = path.posix.dirname(p);
  return owns.some(e => {
    const d = GLOB_CHARS.test(e) ? staticPrefix(e).replace(/\/[^/]*$/, '') : path.posix.dirname(e);
    return dir === d || dir.startsWith(d + '/');
  });
}
