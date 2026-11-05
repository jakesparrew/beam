import { describe, expect, it } from "vitest";
import {
  BLOCK_STEP_TYPES,
  BUILDER_BLOCKS,
  BuilderGraphSchema,
  definitionToGraph,
  findNode,
  graphStepKeys,
  graphToDefinition,
  issueNodeId,
  moveInLane,
  replaceNode,
  stepNodeIds,
  updateLane,
  type BuilderGraph,
  type BuilderNode,
} from "./builder";
import { parseDefinition, STEP_TYPES, type ConditionStep, type Definition, type Step } from "./definition";
import { SEED_AUTOMATIONS } from "./seeds";

const base: Omit<Definition, "steps"> = { schema_version: 1, trigger: { manual: true }, anchor: "enrolment", re_entry: "never", exit_on: [] };
const def = (steps: Step[]): Definition => ({ ...base, steps });
const email = (key: string, extra: Partial<Step> = {}): Step => ({ key, type: "email", template: "welcome-lead-welcome", ...extra }) as Step;
const cond = (key: string, then: string, otherwise: string): ConditionStep => ({ key, type: "condition", if: { has_active_membership: true }, then, else: otherwise });

const roundTrip = (d: Definition) => {
  const r = graphToDefinition(definitionToGraph(d));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};

/** Every `then` / `else` of the step list points to a later step or to the end. */
function forwardOnly(d: Definition): boolean {
  const index = new Map(d.steps.map((s, i) => [s.key, i]));
  return d.steps.every((s, i) => s.type !== "condition" || [s.then, s.else].every((t) => t === "end" || (index.get(t) ?? -1) > i));
}

describe("blocks", () => {
  it("has the twelve blocks of the palette and covers every step type", () => {
    expect(BUILDER_BLOCKS).toHaveLength(12);
    const covered = new Set(Object.values(BLOCK_STEP_TYPES).flat());
    for (const t of STEP_TYPES) expect(covered.has(t)).toBe(true);
  });
});

describe("round trip of the seeded definitions", () => {
  it.each(SEED_AUTOMATIONS.map((s) => [s.slug, s.definition] as const))("%s", (_slug, d) => {
    expect(roundTrip(d)).toEqual(d);
    // The graph is plain JSON and passes the action's input schema.
    const g = JSON.parse(JSON.stringify(definitionToGraph(d))) as BuilderGraph;
    expect(BuilderGraphSchema.safeParse(g).success).toBe(true);
    expect(graphToDefinition(g)).toEqual({ ok: true, value: d });
  });

  it("lays the seeded branch chains out as lanes, not as jumps", () => {
    const usage = SEED_AUTOMATIONS.find((s) => s.slug === "package-usage")!.definition;
    const g = definitionToGraph(usage);
    const first = g.blocks[0]!;
    expect(first.kind).toBe("branch");
    if (first.kind !== "branch") return;
    expect(first.then.blocks.map((b) => b.step.key)).toEqual(["p50", "p50_end"]);
    expect(first.else.blocks).toEqual([]);
    expect(first.else.goto).toBeUndefined();
    expect(g.blocks.map((b) => [b.step.key, b.kind])).toEqual([
      ["c50", "branch"],
      ["c75", "branch"],
      ["c80", "branch"],
      ["c90", "branch"],
      ["c_last", "condition"],
      ["last", "step"],
      ["last_task", "step"],
    ]);
  });
});

describe("round trip of hand-written step lists", () => {
  const cases: [string, Step[]][] = [
    ["linear", [email("a"), { key: "w", type: "wait", minutes: 60 }, email("b")]],
    ["if then continue", [cond("c", "x", "y"), email("x"), email("y")]],
    ["gate", [cond("c", "x", "end"), email("x")]],
    ["gate inside a lane", [cond("b", "g", "e"), cond("g", "t", "end"), email("t"), email("e")]],
    ["end when it holds", [cond("c", "end", "x"), email("x")]],
    ["both end", [email("a"), cond("c", "end", "end"), email("x")]],
    ["else lane first", [cond("c", "y", "x"), email("x"), email("y")]],
    ["jump the lanes cannot express", [cond("c", "z", "y"), email("x"), email("y"), email("z")]],
    ["both to the same later step", [cond("c", "z", "z"), email("x"), email("z")]],
    ["nested", [cond("c1", "a", "c2"), email("a"), cond("a_end", "end", "end"), cond("c2", "b", "end"), email("b"), email("tail")]],
  ];
  it.each(cases)("%s", (_name, steps) => {
    const d = def(steps);
    expect(roundTrip(d)).toEqual(d);
  });

  it("keeps a backward jump of an invalid draft literally, and reports it", () => {
    const d = def([email("a"), cond("c", "a", "end"), email("x")]);
    const r = graphToDefinition(definitionToGraph(d));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toEqual(["branch_backward"]);
  });
});

describe("branch lanes produce forward targets only", () => {
  const node = (key: string): BuilderNode => ({ id: key, kind: "step", step: email(key) as Exclude<Step, ConditionStep> });
  const branch = (key: string, yes: BuilderNode[], no: BuilderNode[], extra: { thenEnd?: boolean; elseEnd?: boolean } = {}): BuilderNode => ({
    id: key,
    kind: "branch",
    step: { key, type: "condition", if: { has_tag: "engaged" } },
    then: { blocks: yes, ...(extra.thenEnd ? { end: true as const } : {}) },
    else: { blocks: no, ...(extra.elseEnd ? { end: true as const } : {}) },
  });
  const graph = (blocks: BuilderNode[]): BuilderGraph => ({ version: 1, trigger: { ...base }, blocks });

  it("targets the first block of a lane, the block after the branch, or the end", () => {
    const g = graph([branch("b1", [node("y1"), branch("b2", [node("y2")], [], { elseEnd: true })], [node("n1")]), node("after")]);
    const r = graphToDefinition(g);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.steps.map((s) => s.key)).toEqual(["b1", "y1", "b2", "y2", "n1", "after"]);
    const [b1, , b2] = r.value.steps as ConditionStep[];
    expect([b1!.then, b1!.else]).toEqual(["y1", "n1"]);
    expect([b2!.then, b2!.else]).toEqual(["y2", "end"]);
    expect(forwardOnly(r.value)).toBe(true);
  });

  it("an empty lane continues after the branch, or ends when the branch is last", () => {
    const r = graphToDefinition(graph([node("a"), branch("b", [], [node("x")])]));
    expect(r.ok && (r.value.steps[1] as ConditionStep)).toMatchObject({ then: "end", else: "x" });
    const r2 = graphToDefinition(graph([branch("b", [node("x")], []), node("z")]));
    expect(r2.ok && (r2.value.steps[0] as ConditionStep)).toMatchObject({ then: "x", else: "z" });
    if (r2.ok) expect(forwardOnly(r2.value)).toBe(true);
  });

  it("a Condition block continues when it holds and ends otherwise", () => {
    const g = graph([{ id: "g", kind: "condition", step: { key: "g", type: "condition", if: { has_tag: "engaged" } } }, node("x")]);
    const r = graphToDefinition(g);
    expect(r.ok && r.value.steps[0]).toMatchObject({ then: "x", else: "end" });
  });

  it("random lane layouts stay forward and parse", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 50; round++) {
      let k = 0;
      const make = (depth: number): BuilderNode[] =>
        Array.from({ length: 1 + rnd(3) }, () => {
          const key = `s${k++}`;
          if (depth < 3 && rnd(3) === 0) return branch(key, rnd(2) ? make(depth + 1) : [], rnd(2) ? make(depth + 1) : [], { thenEnd: rnd(4) === 0, elseEnd: rnd(4) === 0 });
          return node(key);
        });
      const g = graph(make(0));
      const r = graphToDefinition(g);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(forwardOnly(r.value)).toBe(true);
      expect(parseDefinition(r.value).ok).toBe(true);
      // And the definition comes back to the same step list once more.
      expect(roundTrip(r.value)).toEqual(r.value);
    }
  });
});

describe("invalid graphs return issues", () => {
  const graph = (blocks: unknown[]): BuilderGraph => ({ version: 1, trigger: { ...base }, blocks: blocks as BuilderNode[] });
  const step = (key: string): BuilderNode => ({ id: key, kind: "step", step: email(key) as Exclude<Step, ConditionStep> });

  it("an empty flow", () => {
    const r = graphToDefinition(graph([]));
    expect(r.ok === false && r.issues.map((i) => i.code)).toEqual(["builder_empty"]);
  });

  it("a step key used twice names both blocks' step path", () => {
    const r = graphToDefinition(graph([step("a"), { ...step("a"), id: "a2" }]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => [i.code, i.path])).toEqual([["duplicate_step_key", "steps.1.key"]]);
      expect(r.issues[0]?.params?.node).toBe("a2");
    }
  });

  it("a goto to an unknown or an earlier step", () => {
    const b = (key: string, goto: string): BuilderNode => ({ id: key, kind: "branch", step: { key, type: "condition", if: { has_tag: "x" } }, then: { blocks: [], goto }, else: { blocks: [], end: true } });
    const r = graphToDefinition(graph([step("a"), b("b", "nowhere"), b("c", "a"), b("d", "d")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => [i.code, i.path])).toEqual([["branch_target_unknown", "steps.1.then"], ["branch_backward", "steps.2.then"], ["branch_backward", "steps.3.then"]]);
  });

  it("malformed blocks", () => {
    const r = graphToDefinition(graph([{ id: "x", kind: "step", step: { key: "c", type: "condition", if: {}, then: "end", else: "end" } }, { id: "y", kind: "branch", step: email("y") }, { id: "z", kind: "step", step: { key: "z", type: "fax" } }, null]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toEqual(["builder_invalid_node", "builder_invalid_node", "builder_invalid_node", "builder_invalid_node"]);
    expect(graphToDefinition(null as unknown as BuilderGraph).ok).toBe(false);
  });

  it("issues map back to their block", () => {
    const g = definitionToGraph(def([email("a"), cond("c", "x", "end"), email("x", { template: "" })]));
    const ids = stepNodeIds(g);
    const parsed = parseDefinition(graphToDefinition(g).ok ? (graphToDefinition(g) as { value: Definition }).value : null);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(issueNodeId(parsed.issues[0]!, ids)).toBe(ids[2]);
    expect(issueNodeId({ code: "x", path: "trigger", message: "", severity: "error" }, ids)).toBeNull();
  });
});

describe("editing helpers", () => {
  const d = def([cond("c1", "a", "z"), email("a"), email("b"), email("z")]);
  const g = definitionToGraph(d);
  const c1 = g.blocks[0]!;

  it("moves within a lane and keeps the step list consistent", () => {
    expect(c1.kind).toBe("branch");
    const lane = [{ id: c1.id, lane: "then" as const }];
    const moved = updateLane(g.blocks, lane, (l) => moveInLane(l, 1, 0));
    expect(graphStepKeys({ blocks: moved })).toEqual(["c1", "b", "a", "z"]);
    const r = graphToDefinition({ ...g, blocks: moved });
    expect(r.ok && (r.value.steps[0] as ConditionStep).then).toBe("b");
    expect(moveInLane(["x", "y"] as unknown as BuilderNode[], 0, 9)).toEqual(["y", "x"]);
  });

  it("adding a block to an ending lane clears its end", () => {
    const g2 = definitionToGraph(def([cond("c", "end", "x"), email("x")]));
    const id = g2.blocks[0]!.id;
    const next = updateLane(g2.blocks, [{ id, lane: "then" }], (l) => [...l, { id: "new", kind: "step", step: email("new") as Exclude<Step, ConditionStep> }]);
    const b = findNode(next, id);
    expect(b?.kind === "branch" && b.then).toEqual({ blocks: [expect.objectContaining({ id: "new" })] });
  });

  it("replaces and removes nested blocks", () => {
    const aId = c1.kind === "branch" ? c1.then.blocks[0]!.id : "";
    const removed = replaceNode(g.blocks, aId, () => null);
    expect(graphStepKeys({ blocks: removed })).toEqual(["c1", "b", "z"]);
    expect(findNode(removed, aId)).toBeNull();
  });
});
