// Gate helper for CPU contention (OD-13). Two roles in one file:
//
// 1. A Vitest reporter. With BEAM_TIMEOUT_REPORT=<path> set, it writes every failed test file and
//    every error message recorded anywhere in that file's task tree (tests, describe blocks and
//    hooks, which the JSON reporter leaves out), plus the unhandled errors, to <path>.
//
// 2. A CLI: `node timeout-reporter.mjs --retryable <report.json> <workspace>` prints the failed
//    files relative to <workspace> and exits 0 only when every failed file failed on at least one
//    timeout ("Test timed out in" / "Hook timed out in") and there is no other unhandled error.
//    The gate then re-runs exactly those files once, alone; any other failure stays red.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT = /(Test|Hook) timed out in \d+ms/;
const CONTENTION = /timed out|Timeout calling/i;

function messagesOf(task, out) {
  for (const e of task.result?.errors ?? []) out.push(String(e?.message ?? e));
  for (const child of task.tasks ?? []) messagesOf(child, out);
  return out;
}

export default class TimeoutReporter {
  onTestRunEnd(testModules, unhandledErrors) {
    const target = process.env.BEAM_TIMEOUT_REPORT;
    if (!target) return;
    const files = [];
    for (const m of testModules) {
      const task = m.task;
      if (task?.result?.state !== "fail") continue;
      files.push({ file: task.filepath, messages: messagesOf(task, []) });
    }
    const unhandled = [...(unhandledErrors ?? [])].map((e) => String(e?.message ?? e));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ files, unhandled }, null, 2));
    } catch (error) {
      // Never let the report itself turn a run red; without it the gate simply does not retry.
      console.warn(`timeout-reporter: could not write ${target}: ${error?.message ?? error}`);
    }
  }
}

function retryable(reportPath, workspace) {
  if (!fs.existsSync(reportPath)) return null;
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!report.files?.length) return null;
  if ((report.unhandled ?? []).some((m) => !CONTENTION.test(m))) return null;
  for (const f of report.files) if (!f.messages.some((m) => TIMEOUT.test(m))) return null;
  const root = path.resolve(workspace);
  return report.files.map((f) => path.relative(root, f.file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [flag, reportPath, workspace] = process.argv.slice(2);
  if (flag !== "--retryable" || !reportPath || !workspace) {
    console.error("usage: node scripts/build/timeout-reporter.mjs --retryable <report.json> <workspace>");
    process.exit(2);
  }
  const files = retryable(reportPath, workspace);
  if (!files) process.exit(1);
  console.log(files.join(" "));
}
