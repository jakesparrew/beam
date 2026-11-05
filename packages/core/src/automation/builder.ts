/**
 * The visual workflow builder's graph (automation spec 5 and automation-P10, R4): a second view
 * over the same definition JSON, with no engine of its own. `definitionToGraph` turns the step
 * list into a vertical flow of blocks with two lanes per branch; `graphToDefinition` turns the
 * flow back into the step list, so `graphToDefinition(definitionToGraph(d))` gives `d` back.
 *
 * The twelve blocks (blueprint 51) and the step types they write:
 * Trigger -> `trigger` (with anchor, subject, audience, re-entry and exits), Condition -> a
 * `condition` step that ends the journey when it does not hold (or a step's `unless`), Delay ->
 * `wait`, Branch -> `condition` with `then` / `else`, Send email -> `email`, Create task -> `task`,
 * Apply tag -> `tag` / `untag`, Change status -> `status_override`, Add/remove sequence ->
 * `enrol` / `exit`, Notify team member -> `notify_slack`, Update field -> `set_field`, Trigger
 * webhook -> `webhook`.
 *
 * Lanes and the step list. The steps run in list order and a `condition` step jumps forward to
 * `then` / `else`. A branch writes its own step, then the blocks of its "yes" lane, then those of
 * its "no" lane, then whatever follows the branch. A lane's target is its first block; an empty
 * lane either continues after the branch, ends the journey (`end`) or, for a jump the lanes cannot
 * express, names a later step (`goto`). The engine runs the step list as it always did, so the
 * last block of a "yes" lane continues with the first block of a non-empty "no" lane unless it
 * ends the journey (the seeded journeys close such lanes with a branch that ends both ways).
 * Lanes therefore only ever produce forward targets; a `goto` that points backwards or nowhere
 * is reported as an issue.
 */
import { z } from "zod";
import { MAX_STEPS, STEP_TYPES, type ConditionStep, type Definition, type DefinitionIssue, type Step, type StepType } from "./definition";

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** The twelve blocks of the palette, in palette order. */
export const BUILDER_BLOCKS = ["trigger", "condition", "delay", "branch", "email", "task", "tag", "status", "sequence", "notify", "field", "webhook"] as const;
export type BuilderBlock = (typeof BUILDER_BLOCKS)[number];

/** The step types each block writes (Trigger writes the definition's trigger, not a step). */
export const BLOCK_STEP_TYPES: Record<BuilderBlock, readonly StepType[]> = {
  trigger: [],
  condition: ["condition"],
  delay: ["wait"],
  branch: ["condition"],
  email: ["email"],
  task: ["task"],
  tag: ["tag", "untag"],
  status: ["status_override"],
  sequence: ["enrol", "exit"],
  notify: ["notify_slack"],
  field: ["set_field"],
  webhook: ["webhook"],
};

/** The block of a step that is not a `condition` (a condition is a Condition or Branch block). */
export function blockOfStepType(type: Exclude<StepType, "condition">): BuilderBlock {
  const found = BUILDER_BLOCKS.find((b) => b !== "condition" && b !== "branch" && BLOCK_STEP_TYPES[b].includes(type));
  return found ?? "email";
}

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

export type ActionStep = Exclude<Step, ConditionStep>;
/** A condition step without its targets: the lanes decide them. */
export type BranchStep = Omit<ConditionStep, "then" | "else">;
/** One lane of a branch: its blocks, or for an empty lane where it goes (default: after the branch). */
export type BranchLane = { blocks: BuilderNode[]; end?: true; goto?: string };
export type BuilderNode =
  /** Delay, Send email, Create task, Apply tag, Change status, Add/remove sequence, Notify, Update field, Webhook. */
  | { id: string; kind: "step"; step: ActionStep }
  /** Condition: continue with the next block when `if` holds, end the journey otherwise. */
  | { id: string; kind: "condition"; step: BranchStep }
  /** Branch: the "yes" lane when `if` holds, the "no" lane otherwise. */
  | { id: string; kind: "branch"; step: BranchStep; then: BranchLane; else: BranchLane };
/** The Trigger block: everything of the definition except its steps. */
export type BuilderTrigger = Omit<Definition, "steps">;
export type BuilderGraph = { version: 1; trigger: BuilderTrigger; blocks: BuilderNode[] };

/** Issue codes the graph itself can produce (catalogue `automation.issue.<code>`). */
export const BUILDER_ISSUE_CODES = ["builder_empty", "builder_invalid_node", "duplicate_step_key", "branch_target_unknown", "branch_backward"] as const;

// ---------------------------------------------------------------------------
// definitionToGraph
// ---------------------------------------------------------------------------

const END = "end" as const;
type Target = number | typeof END | { raw: string };

function without<T extends object, K extends keyof T>(o: T, keys: K[]): Omit<T, K> {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

/** The definition as a flow of blocks. Works on any definition-shaped value (also an invalid draft). */
export function definitionToGraph(def: Definition): BuilderGraph {
  const steps = Array.isArray(def.steps) ? def.steps : [];
  const indexOf = new Map<string, number>();
  steps.forEach((s, i) => {
    if (!indexOf.has(s.key)) indexOf.set(s.key, i);
  });
  const target = (v: unknown): Target => {
    const key = typeof v === "string" ? v : END;
    if (key === END) return END;
    const i = indexOf.get(key);
    return i === undefined ? { raw: key } : i;
  };
  const literal = (t: Target, s: string): Omit<BranchLane, "blocks"> => (t === END ? { end: true } : { goto: s });
  let seq = 0;
  const id = (key: string) => `n${seq++}_${key}`;

  const lane = (lo: number, hi: number): BuilderNode[] => {
    const out: BuilderNode[] = [];
    let i = lo;
    while (i < hi) {
      const s = steps[i]!;
      if (s.type !== "condition") {
        out.push({ id: id(s.key), kind: "step", step: s });
        i++;
        continue;
      }
      const core = without(s, ["then", "else"]) as BranchStep;
      const t = target(s.then);
      const e = target(s.else);
      const next = i + 1;
      // Continue when the condition holds, end otherwise: the Condition block.
      if (t === next && e === END) {
        out.push({ id: id(s.key), kind: "condition", step: core });
        i = next;
        continue;
      }
      let x: number;
      let y: number;
      let thenRest: Omit<BranchLane, "blocks"> = {};
      let elseRest: Omit<BranchLane, "blocks"> = {};
      if (t === next && e === next) [x, y] = [next, next];
      else if (t === next && typeof e === "number" && e > next && e <= hi) [x, y] = [e, e];
      else if (t === END && (e === END || e === next)) {
        [x, y] = [next, next];
        thenRest = { end: true };
        if (e === END) elseRest = { end: true };
      } else if (typeof t === "number" && t > next && t <= hi && e === next) [x, y] = [next, t];
      else {
        // A jump the lanes cannot express: both lanes empty, naming their targets literally.
        [x, y] = [next, next];
        thenRest = literal(t, String(s.then));
        elseRest = literal(e, String(s.else));
      }
      out.push({ id: id(s.key), kind: "branch", step: core, then: { blocks: lane(next, x), ...thenRest }, else: { blocks: lane(x, y), ...elseRest } });
      i = y;
    }
    return out;
  };

  const trigger = without(def, ["steps"]) as BuilderTrigger;
  return { version: 1, trigger, blocks: lane(0, steps.length) };
}

// ---------------------------------------------------------------------------
// graphToDefinition
// ---------------------------------------------------------------------------

type Ref = { index: number } | { end: true } | { key: string };
type Entry = { node: BuilderNode; step: Step | BranchStep; then?: Ref; else?: Ref; lane: string };

const issue = (code: string, path: string, message: string, params: Record<string, string | number>): DefinitionIssue => ({ code, path, message, severity: "error", params });

/**
 * The flow back as a definition. Structural problems of the graph (no blocks, a malformed block,
 * a step key used twice, a `goto` to an unknown or earlier step) are issues; field values are not
 * checked here (the draft is saved with them and `parseDefinition` / `validateDefinition` report
 * them, `params.node` names the block of each step path through `stepNodeIds`).
 */
export function graphToDefinition(g: BuilderGraph): { ok: true; value: Definition } | { ok: false; issues: DefinitionIssue[] } {
  const issues: DefinitionIssue[] = [];
  const entries: Entry[] = [];

  const laneRef = (lane: BranchLane, start: number, after: number): Ref =>
    lane.blocks.length > 0 ? { index: start } : lane.end ? { end: true } : typeof lane.goto === "string" && lane.goto !== "" ? { key: lane.goto } : { index: after };

  const flatten = (blocks: unknown, lanePath: string): void => {
    if (!Array.isArray(blocks)) {
      issues.push(issue("builder_invalid_node", "steps", "a lane is not a list of blocks", { lane: lanePath }));
      return;
    }
    blocks.forEach((raw: unknown, n) => {
      const node = raw as BuilderNode;
      const where = `${lanePath}.${n}`;
      const step = node && typeof node === "object" ? (node.step as unknown as Record<string, unknown> | undefined) : undefined;
      const validStep = !!step && typeof step === "object" && typeof step.key === "string" && typeof step.type === "string" && (STEP_TYPES as readonly string[]).includes(step.type);
      const kindOk = node?.kind === "step" ? step?.type !== "condition" : node?.kind === "condition" || node?.kind === "branch" ? step?.type === "condition" : false;
      if (!validStep || !kindOk || typeof node.id !== "string") {
        issues.push(issue("builder_invalid_node", "steps", `block ${where} is not a valid block`, { lane: where, ...(typeof node?.id === "string" ? { node: node.id } : {}) }));
        return;
      }
      if (node.kind === "step") {
        entries.push({ node, step: node.step, lane: where });
        return;
      }
      const core = without(node.step as BranchStep & { then?: unknown; else?: unknown }, ["then", "else"]);
      if (node.kind === "condition") {
        const self = entries.length;
        entries.push({ node, step: core, then: { index: self + 1 }, else: { end: true }, lane: where });
        return;
      }
      const entry: Entry = { node, step: core, lane: where };
      entries.push(entry);
      const thenLane = node.then && typeof node.then === "object" ? node.then : { blocks: [] };
      const elseLane = node.else && typeof node.else === "object" ? node.else : { blocks: [] };
      const thenStart = entries.length;
      flatten(thenLane.blocks ?? [], `${where}.then`);
      const elseStart = entries.length;
      flatten(elseLane.blocks ?? [], `${where}.else`);
      const after = entries.length;
      entry.then = laneRef({ ...thenLane, blocks: thenLane.blocks ?? [] }, thenStart, after);
      entry.else = laneRef({ ...elseLane, blocks: elseLane.blocks ?? [] }, elseStart, after);
    });
  };

  if (!g || typeof g !== "object" || !g.trigger || typeof g.trigger !== "object") {
    return { ok: false, issues: [issue("builder_invalid_node", "trigger", "the graph has no trigger block", {})] };
  }
  flatten(g.blocks, "blocks");
  if (entries.length === 0 && issues.length === 0) issues.push(issue("builder_empty", "steps", "add at least one block after the trigger", {}));

  const keyIndex = new Map<string, number>();
  entries.forEach((e, i) => {
    const key = e.step.key;
    if (keyIndex.has(key)) issues.push(issue("duplicate_step_key", `steps.${i}.key`, `step key ${key} is used twice`, { node: e.node.id, key }));
    else keyIndex.set(key, i);
  });

  const resolve = (ref: Ref, i: number, branch: "then" | "else", node: string): string => {
    if ("end" in ref) return END;
    if ("index" in ref) return ref.index < entries.length ? entries[ref.index]!.step.key : END;
    if (ref.key === END) return END;
    const t = keyIndex.get(ref.key);
    if (t === undefined) issues.push(issue("branch_target_unknown", `steps.${i}.${branch}`, `no step ${ref.key}`, { node, target: ref.key }));
    else if (t <= i) issues.push(issue("branch_backward", `steps.${i}.${branch}`, `${branch} must point to a later step or end`, { node, target: ref.key }));
    return ref.key;
  };

  const steps: Step[] = entries.map((e, i) => {
    if (!e.then || !e.else) return e.step as Step;
    const thenKey = resolve(e.then, i, "then", e.node.id);
    const elseKey = resolve(e.else, i, "else", e.node.id);
    return { ...(e.step as BranchStep), then: thenKey, else: elseKey };
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { ...g.trigger, steps } };
}

/** The block id of every step position of `graphToDefinition`'s step list (for issues on `steps.<i>`). */
export function stepNodeIds(g: BuilderGraph): string[] {
  const out: string[] = [];
  const walk = (blocks: BuilderNode[]) => {
    for (const b of blocks) {
      out.push(b.id);
      if (b.kind === "branch") {
        walk(b.then.blocks);
        walk(b.else.blocks);
      }
    }
  };
  walk(Array.isArray(g.blocks) ? g.blocks : []);
  return out;
}

/** The block id an issue belongs to (`params.node`, or the step position of its path), or null for the trigger. */
export function issueNodeId(i: DefinitionIssue, ids: readonly string[]): string | null {
  if (typeof i.params?.node === "string") return i.params.node;
  const m = /^steps\.(\d+)(?:\.|$)/.exec(i.path);
  return m ? (ids[Number(m[1])] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Editing helpers (pure; the canvas calls them)
// ---------------------------------------------------------------------------

/** Every step key in the graph, in step-list order. */
export function graphStepKeys(g: Pick<BuilderGraph, "blocks">): string[] {
  const keys: string[] = [];
  const walk = (blocks: BuilderNode[]) => {
    for (const b of blocks) {
      keys.push(b.step.key);
      if (b.kind === "branch") {
        walk(b.then.blocks);
        walk(b.else.blocks);
      }
    }
  };
  walk(g.blocks);
  return keys;
}

/** A lane address: `[]` is the main flow, `[{ id, lane: 'then' }]` the "yes" lane of branch `id`, and so on. */
export type LanePath = { id: string; lane: "then" | "else" }[];

/** The blocks of the lane at `path`, or null when the path names no branch. */
export function laneAt(blocks: BuilderNode[], path: LanePath): BuilderNode[] | null {
  let cur = blocks;
  for (const p of path) {
    const b = cur.find((x) => x.id === p.id);
    if (!b || b.kind !== "branch") return null;
    cur = b[p.lane].blocks;
  }
  return cur;
}

/** A copy of `blocks` with the lane at `path` replaced by `fn(lane)` (unchanged when the path names no branch). */
export function updateLane(blocks: BuilderNode[], path: LanePath, fn: (lane: BuilderNode[]) => BuilderNode[]): BuilderNode[] {
  if (path.length === 0) return fn(blocks);
  const [head, ...rest] = path;
  return blocks.map((b) => {
    if (b.id !== head!.id || b.kind !== "branch") return b;
    const lane = b[head!.lane];
    const nextBlocks = updateLane(lane.blocks, rest, fn);
    // A lane that gets blocks no longer ends or jumps: its first block is its target.
    const nextLane: BranchLane = nextBlocks.length > 0 ? { blocks: nextBlocks } : { ...lane, blocks: nextBlocks };
    return { ...b, [head!.lane]: nextLane };
  });
}

/** Moves the block at `from` to `to` inside one lane (indices are clamped). */
export function moveInLane(lane: BuilderNode[], from: number, to: number): BuilderNode[] {
  if (from < 0 || from >= lane.length) return lane;
  const target = Math.max(0, Math.min(lane.length - 1, to));
  if (target === from) return lane;
  const next = [...lane];
  const [b] = next.splice(from, 1);
  next.splice(target, 0, b!);
  return next;
}

/** Replaces the block `id` anywhere in the graph. */
export function replaceNode(blocks: BuilderNode[], id: string, fn: (b: BuilderNode) => BuilderNode | null): BuilderNode[] {
  const out: BuilderNode[] = [];
  for (const b of blocks) {
    if (b.id === id) {
      const r = fn(b);
      if (r) out.push(r);
      continue;
    }
    out.push(b.kind === "branch" ? { ...b, then: { ...b.then, blocks: replaceNode(b.then.blocks, id, fn) }, else: { ...b.else, blocks: replaceNode(b.else.blocks, id, fn) } } : b);
  }
  return out;
}

/** Finds a block anywhere in the graph. */
export function findNode(blocks: BuilderNode[], id: string): BuilderNode | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    if (b.kind === "branch") {
      const hit = findNode(b.then.blocks, id) ?? findNode(b.else.blocks, id);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input schema (server actions)
// ---------------------------------------------------------------------------

type NodeJson =
  | { id: string; kind: "step"; step: Record<string, unknown> }
  | { id: string; kind: "condition"; step: Record<string, unknown> }
  | { id: string; kind: "branch"; step: Record<string, unknown>; then: LaneJson; else: LaneJson };
type LaneJson = { blocks: NodeJson[]; end?: true | undefined; goto?: string | undefined };

const NodeId = z.string().min(1).max(120);
const StepJson = z.record(z.string(), z.unknown());
const LaneSchema: z.ZodType<LaneJson> = z.lazy(() =>
  z.strictObject({ blocks: z.array(NodeSchema).max(MAX_STEPS), end: z.literal(true).optional(), goto: z.string().max(80).optional() }),
);
const NodeSchema: z.ZodType<NodeJson> = z.lazy(() =>
  z.union([
    z.strictObject({ id: NodeId, kind: z.literal("step"), step: StepJson }),
    z.strictObject({ id: NodeId, kind: z.literal("condition"), step: StepJson }),
    z.strictObject({ id: NodeId, kind: z.literal("branch"), step: StepJson, then: LaneSchema, else: LaneSchema }),
  ]),
);

/**
 * The shape of a `BuilderGraph` as it arrives from the browser. Block fields stay loose here:
 * `graphToDefinition` checks the structure, the definition schema checks the fields.
 */
export const BuilderGraphSchema = z.strictObject({
  version: z.literal(1),
  trigger: z.record(z.string(), z.unknown()),
  blocks: z.array(NodeSchema).max(MAX_STEPS),
});
