#!/usr/bin/env node
// Build state and scheduler for the orchestrator (BS-2). A package may start as soon as every
// package in its dependsOn is merged and no running or unmerged package owns an overlapping path.
//   node scripts/build/state.mjs init
//   node scripts/build/state.mjs status
//   node scripts/build/state.mjs ready [limit]
//   node scripts/build/state.mjs start <id> <baseSha> [runId]
//   node scripts/build/state.mjs done <id> <branchSha> [minutes]
//   node scripts/build/state.mjs merged <id> <mergeSha>
//   node scripts/build/state.mjs failed <id> <note...>
//   node scripts/build/state.mjs set <id> <field> <value>
import { loadPlan, readJson, writeJson, STATE, expandOwns, ownsOverlap } from './lib.mjs';

const plan = loadPlan();
const byId = Object.fromEntries(plan.packages.map(p => [p.id, p]));
const RANK = { V1: 0, R2: 1, R3: 2, R4: 3 };
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

let state = readJson(STATE, null);
const save = () => writeJson(STATE, state);
function ensure() {
  if (!state) state = { version: 1, packages: {} };
  for (const p of plan.packages) state.packages[p.id] ??= { status: 'pending', attempts: 0 };
}

// Longest weighted chain (estimateMinutes) from a package to the end of the graph.
const dependents = {};
for (const p of plan.packages) for (const d of p.dependsOn || []) (dependents[d] ??= []).push(p.id);
const memo = {};
function chain(id) {
  if (memo[id] != null) return memo[id];
  const own = byId[id]?.estimateMinutes ?? 60;
  return (memo[id] = own + Math.max(0, ...(dependents[id] || []).map(chain)));
}

function readyList() {
  const active = Object.entries(state.packages).filter(([, s]) => s.status === 'running' || s.status === 'done' || s.status === 'failed');
  const activeOwns = active.map(([id]) => [id, byId[id] ? expandOwns(byId[id]) : state.packages[id].owns || []]);
  const out = [];
  for (const p of plan.packages) {
    const s = state.packages[p.id];
    if (s.status !== 'pending') continue;
    const missing = (p.dependsOn || []).filter(d => state.packages[d]?.status !== 'merged');
    if (missing.length) continue;
    const owns = expandOwns(p);
    const clash = activeOwns.map(([id, o]) => [id, ownsOverlap(owns, o)]).find(([, c]) => c);
    out.push({ id: p.id, wave: p.wave, release: p.release, est: p.estimateMinutes, chain: chain(p.id), blockedBy: clash ? `${clash[0]} (${clash[1].join(' ~ ')})` : null });
  }
  for (const [id, s] of Object.entries(state.packages)) {
    if (!s.fixer || s.status !== 'pending') continue;
    const clash = activeOwns.filter(([aid]) => aid !== id).map(([aid, o]) => [aid, ownsOverlap(s.owns, o)]).find(([, c]) => c);
    out.push({ id, wave: -1, release: 'V1', est: 30, chain: 99999, blockedBy: clash ? `${clash[0]} (${clash[1].join(' ~ ')})` : null });
  }
  out.sort((a, b) => RANK[a.release] - RANK[b.release] || b.chain - a.chain || a.wave - b.wave);
  return out;
}

const [cmd, ...a] = process.argv.slice(2);
ensure();
switch (cmd) {
  case 'init': save(); console.log(`state: ${Object.keys(state.packages).length} packages`); break;
  case 'ready': {
    const limit = Number(a[0] || 50);
    const list = readyList();
    for (const r of list.slice(0, limit)) console.log(`${r.blockedBy ? 'WAIT ' : 'READY'} ${r.id.padEnd(16)} ${r.release} w${String(r.wave).padStart(2, '0')} est ${String(r.est).padStart(3)} chain ${String(r.chain).padStart(4)}${r.blockedBy ? '  blocked by ' + r.blockedBy : ''}`);
    if (!list.length) console.log('(nothing ready)');
    break;
  }
  case 'start': { const [id, base, run] = a; Object.assign(state.packages[id], { status: 'running', baseSha: base, runId: run || null, startedAt: now(), attempts: (state.packages[id].attempts || 0) + 1 }); save(); console.log(`${id} running from ${base}`); break; }
  case 'done': { const [id, sha, minutes] = a; Object.assign(state.packages[id], { status: 'done', branchSha: sha, endedAt: now(), minutes: minutes ? Number(minutes) : undefined }); save(); console.log(`${id} done at ${sha}`); break; }
  case 'merged': { const [id, sha] = a; Object.assign(state.packages[id], { status: 'merged', mergeSha: sha, mergedAt: now() }); save(); console.log(`${id} merged as ${sha}`); break; }
  case 'failed': { const [id, ...note] = a; Object.assign(state.packages[id], { status: 'failed', note: note.join(' '), endedAt: now() }); save(); console.log(`${id} failed`); break; }
  case 'pending': { const [id] = a; Object.assign(state.packages[id], { status: 'pending' }); save(); console.log(`${id} pending`); break; }
  case 'add-fixer': {
    // add-fixer <id> <module> <goal...> --from <pkgId,pkgId,...> [--extra <glob,glob>]
    const fi = a.indexOf('--from'); const ei = a.indexOf('--extra');
    const [id, module, ...rest] = a.slice(0, fi);
    const from = a[fi + 1].split(',');
    const extra = ei >= 0 ? a[ei + 1].split(',') : [];
    const owns = [...new Set([...from.flatMap(f => (byId[f] ? expandOwns(byId[f]) : state.packages[f]?.owns || [])), ...extra])];
    state.packages[id] = { status: 'pending', attempts: 0, fixer: true, module, goal: rest.join(' '), from, owns, dependsOn: from.filter(f => byId[f]) };
    save(); console.log(`${id}: fixer for ${module}, ${owns.length} owned paths from ${from.join(', ')}`); break;
  }
  case 'set': { const [id, field, ...v] = a; state.packages[id][field] = v.join(' '); save(); break; }
  case 'status':
  default: {
    const counts = {};
    for (const [id, s] of Object.entries(state.packages)) { const r = byId[id]?.release || 'fix'; counts[r] ??= {}; counts[r][s.status] = (counts[r][s.status] || 0) + 1; }
    console.log('by release:', JSON.stringify(counts));
    const show = st => Object.entries(state.packages).filter(([, s]) => s.status === st).map(([id, s]) => `${id}${s.attempts > 1 ? `(x${s.attempts})` : ''}`).join(' ');
    console.log('running:', show('running') || '-');
    console.log('done, not merged:', show('done') || '-');
    console.log('failed:', show('failed') || '-');
    const r = readyList();
    console.log('ready:', r.filter(x => !x.blockedBy).map(x => x.id).join(' ') || '-');
    const left = plan.packages.filter(p => state.packages[p.id].status !== 'merged').reduce((n, p) => n + (p.estimateMinutes || 0), 0);
    console.log(`merged ${Object.values(state.packages).filter(s => s.status === 'merged').length}/${plan.packages.length}; estimated agent-minutes left ${left}`);
  }
}
