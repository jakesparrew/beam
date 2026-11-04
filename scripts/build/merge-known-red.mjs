// Resolves a merge conflict in docs/build/known-red.txt (OD-16). The file is a set of lines:
// fixers started from the same base each delete their own line, which git reports as a conflict
// when the lines are adjacent. A base line survives only if neither side removed it; a line that
// either side added is kept. Order: ours, then theirs' new lines. Run during a conflicted merge.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const FILE = 'docs/build/known-red.txt';
const stage = (n) => {
  try {
    return execFileSync('git', ['show', `:${n}:${FILE}`], { encoding: 'utf8' }).split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
};
const [base, ours, theirs] = [stage(1), stage(2), stage(3)];
const B = new Set(base), O = new Set(ours), T = new Set(theirs);
const keep = (line) => (B.has(line) ? O.has(line) && T.has(line) : O.has(line) || T.has(line));
const out = [];
for (const line of [...ours, ...theirs]) if (keep(line) && !out.includes(line)) out.push(line);
fs.writeFileSync(FILE, out.join('\n') + '\n');
const kept = out.filter((l) => !l.startsWith('#')).length;
console.log(`known-red.txt resolved: ${kept} entr${kept === 1 ? 'y' : 'ies'} kept`);
