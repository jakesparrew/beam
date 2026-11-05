"use client";
/**
 * The visual workflow builder (automation-P10, R4; spec 5): a vertical flow of blocks over the
 * same draft JSON as the form editor. The palette adds blocks (press or drag), the canvas shows
 * the Trigger block and the flow with two lanes per Branch, the side panel edits the selected
 * block. Blocks reorder within their lane by drag and drop, Move buttons or Alt+Arrow keys.
 * Every change is checked in the browser (`graphToDefinition`, then the definition schema) and
 * each block carries a badge with its issues; Save posts `saveBuilderGraph` (the issues the
 * server finds, such as an unpublished template, come back and stay until the next change);
 * Publish opens the editor's publish dialog. State lives in this component and travels as
 * props: no React context (CONVENTIONS 12). Every string arrives through `labels`.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, Button } from "@beam/ui";
import { parseDefinition, type DefinitionIssue, type StepType } from "@beam/core/automation";
import {
  BLOCK_STEP_TYPES,
  findNode,
  graphStepKeys,
  graphToDefinition,
  issueNodeId,
  laneAt,
  moveInLane,
  replaceNode,
  stepNodeIds,
  updateLane,
  type BuilderBlock,
  type BuilderGraph,
  type BuilderNode,
  type BuilderTrigger,
  type LanePath,
} from "../../../../../../packages/core/src/automation/builder";
import { saveBuilderGraph } from "../../actions";
import type { EditorOptions, Json } from "../condition-builder";
import { errorText, fill, issueText, type IssueLike, type Labels } from "../outcome-badge";
import { PublishDialog } from "../publish-dialog";
import { newStep, type IssueView, type StepJson } from "../step-forms";
import { BlockPalette } from "./block-palette";
import { BlockCard } from "./block";
import { Lane, laneKey, type CanvasApi } from "./branch-lane";
import { NodePanel, TriggerPanel } from "./side-panel";

type Obj = { [k: string]: Json };
type Located = { issue: IssueLike; node: string | null };
const TRIGGER = "trigger";

/** Where a block sits: its lane and index. */
function locate(blocks: BuilderNode[], id: string, path: LanePath = []): { path: LanePath; index: number } | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.id === id) return { path, index: i };
    if (b.kind === "branch") {
      const hit = locate(b.then.blocks, id, [...path, { id: b.id, lane: "then" }]) ?? locate(b.else.blocks, id, [...path, { id: b.id, lane: "else" }]);
      if (hit) return hit;
    }
  }
  return null;
}

/** The ids of a block and every block in its lanes. */
function subtreeIds(node: BuilderNode): string[] {
  return node.kind === "branch" ? [node.id, ...node.then.blocks.flatMap(subtreeIds), ...node.else.blocks.flatMap(subtreeIds)] : [node.id];
}

/** Issues of the graph as the browser sees them: structure first, then the definition schema. */
function liveIssues(g: BuilderGraph): Located[] {
  const ids = stepNodeIds(g);
  const conv = graphToDefinition(g);
  const issues = conv.ok ? (() => {
    const parsed = parseDefinition(conv.value);
    return parsed.ok ? [] : parsed.issues;
  })() : conv.issues;
  return issues.map((issue) => ({ issue, node: issueNodeId(issue, ids) }));
}

const rebase = (i: IssueLike): IssueLike => ({ ...i, path: i.path.replace(/^steps\.\d+/, "steps.0") });

export function BuilderCanvas({
  automation,
  initialGraph,
  savedIssues,
  options,
  migratableCount,
  canEdit,
  canPublish,
  labels: l,
}: {
  automation: { id: string; slug: string; name: string };
  initialGraph: BuilderGraph;
  /** Issues of the saved draft (step paths in the step list of `initialGraph`). */
  savedIssues: DefinitionIssue[];
  options: EditorOptions;
  migratableCount: number;
  canEdit: boolean;
  canPublish: boolean;
  labels: Labels;
}) {
  const router = useRouter();
  const readOnly = !canEdit;
  const [graph, setGraph] = useState<BuilderGraph>(initialGraph);
  const [selected, setSelected] = useState<string | null>(TRIGGER);
  const [activeLane, setActiveLane] = useState<LanePath>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [server, setServer] = useState<{ issues: DefinitionIssue[]; located: Located[] }>(() => {
    const ids = stepNodeIds(initialGraph);
    return { issues: savedIssues, located: savedIssues.map((issue) => ({ issue, node: issueNodeId(issue, ids) })) };
  });
  const seq = useRef(0);

  const live = useMemo(() => liveIssues(graph), [graph]);
  const shown = useMemo(() => {
    if (dirty) return live;
    const seen = new Set(live.map((x) => `${x.issue.code}|${x.issue.path}`));
    return [...live, ...server.located.filter((x) => !seen.has(`${x.issue.code}|${x.issue.path}`))];
  }, [dirty, live, server]);
  const issueCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const x of shown) if (x.issue.severity === "error") out[x.node ?? TRIGGER] = (out[x.node ?? TRIGGER] ?? 0) + 1;
    return out;
  }, [shown]);
  const keys = graphStepKeys(graph);

  const change = (fn: (g: BuilderGraph) => BuilderGraph) => {
    setGraph((g) => fn(g));
    setDirty(true);
    setMessage(null);
  };
  const newId = () => `new_${seq.current++}`;
  const uniqueKey = (type: StepType, taken: string[]) => {
    let n = 1;
    while (taken.includes(`${type}_${n}`)) n++;
    return `${type}_${n}`;
  };

  /** A node made from a step of the editor's `newStep` (a `condition` step becomes a Branch). */
  const nodeFromStep = (step: StepJson, asCondition = false): BuilderNode => {
    const type = step.type as StepType;
    const taken = graphStepKeys(graph);
    const key = typeof step.key === "string" && !taken.includes(step.key) ? step.key : uniqueKey(type, taken);
    if (type === "condition") {
      const { then: _t, else: _e, ...core } = step;
      const s = { ...core, key } as unknown as Extract<BuilderNode, { kind: "condition" }>["step"];
      return asCondition ? { id: newId(), kind: "condition", step: s } : { id: newId(), kind: "branch", step: s, then: { blocks: [] }, else: { blocks: [] } };
    }
    return { id: newId(), kind: "step", step: { ...step, key } as unknown as Extract<BuilderNode, { kind: "step" }>["step"] };
  };

  const insertNode = (path: LanePath, index: number, node: BuilderNode) => {
    change((g) => ({ ...g, blocks: updateLane(g.blocks, path, (lane) => [...lane.slice(0, index), node, ...lane.slice(index)]) }));
    setSelected(node.id);
  };

  const api: CanvasApi = {
    l,
    readOnly,
    selectedId: selected,
    activeLane: laneKey(activeLane),
    issueCounts,
    onSelect: (id) => setSelected(id),
    onMove: (path, from, to) => change((g) => ({ ...g, blocks: updateLane(g.blocks, path, (lane) => moveInLane(lane, from, to)) })),
    onRemove: (id) => {
      change((g) => ({ ...g, blocks: replaceNode(g.blocks, id, () => null) }));
      if (selected === id) setSelected(null);
      if (activeLane.some((p) => p.id === id)) setActiveLane([]);
    },
    onInsert: (path, index, block) => {
      if (block === "trigger") return;
      const type = BLOCK_STEP_TYPES[block][0]!;
      insertNode(path, index, nodeFromStep(newStep(type, keys, options), block === "condition"));
    },
    onActivateLane: (path) => setActiveLane(path),
  };

  const addToActiveLane = (block: BuilderBlock) => {
    const lane = laneAt(graph.blocks, activeLane);
    if (lane) api.onInsert(activeLane, lane.length, block);
    else {
      setActiveLane([]);
      api.onInsert([], graph.blocks.length, block);
    }
  };

  const laneName = (path: LanePath): string => {
    const last = path[path.length - 1];
    if (!last) return l["builder.lane_main"] ?? "";
    const b = findNode(graph.blocks, last.id);
    return fill(l["builder.lane_of"], { branch: b?.step.key ?? "", lane: l[`builder.lane_${last.lane}`] ?? last.lane });
  };

  async function save() {
    setBusy(true);
    setMessage(null);
    const snapshot = graph;
    try {
      const r = await saveBuilderGraph({ automationId: automation.id, graph: snapshot });
      if (r.ok) {
        const ids = stepNodeIds(snapshot);
        const located = r.data.issues.map((issue) => ({ issue, node: issueNodeId(issue, ids) }));
        if (r.data.saved) {
          setServer({ issues: r.data.issues, located });
          setDirty(false);
          setMessage({ kind: "ok", text: l["builder.saved"] ?? "" });
          router.refresh();
        } else setMessage({ kind: "error", text: l["builder.not_saved"] ?? "" });
      } else setMessage({ kind: "error", text: errorText(r.error, l) });
    } catch {
      setMessage({ kind: "error", text: l["errors.generic"] ?? "" });
    } finally {
      setBusy(false);
    }
  }

  const selectedNode = selected && selected !== TRIGGER ? findNode(graph.blocks, selected) : null;
  const nodeIssues: IssueView[] = selectedNode
    ? shown.filter((x) => x.node === selectedNode.id).map((x) => ({ ...rebase(x.issue), text: issueText(x.issue, l) }))
    : [];
  const triggerIssues: IssueView[] = shown.filter((x) => x.node === null).map((x) => ({ path: x.issue.path, code: x.issue.code, severity: x.issue.severity, text: issueText(x.issue, l) }));
  const laterKeys = (() => {
    if (!selectedNode) return [];
    const ids = stepNodeIds(graph);
    const inside = new Set(subtreeIds(selectedNode));
    const at = ids.indexOf(selectedNode.id);
    return keys.filter((_, i) => i > at && !inside.has(ids[i]!));
  })();
  const keyOf = (node: string | null) => (node ? (findNode(graph.blocks, node)?.step.key ?? "") : (l["builder.block.trigger"] ?? ""));

  return (
    <div className="grid gap-4" data-testid="builder">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <Button onClick={() => void save()} disabled={busy} data-testid="builder-save">
            {busy ? l["common.saving"] : l["builder.save"]}
          </Button>
        ) : null}
        {canPublish ? <PublishDialog automationId={automation.id} migratableCount={migratableCount} issues={server.issues} dirty={dirty} labels={l} /> : null}
        <Button asChild variant="outline">
          <Link href={`/admin/automations/${automation.id}/edit`} data-testid="builder-open-form">
            {l["builder.open_form"]}
          </Link>
        </Button>
        {dirty ? <span className="text-sm text-muted-foreground">{l["builder.unsaved"]}</span> : null}
      </div>
      {readOnly ? <p className="text-sm text-muted-foreground">{l["builder.readonly"]}</p> : <p className="text-sm text-muted-foreground">{l["builder.keyboard_hint"]}</p>}
      {message ? (
        <Alert variant={message.kind === "error" ? "destructive" : "default"} role={message.kind === "error" ? "alert" : "status"} data-testid="builder-message">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <section aria-labelledby="builder-issues" className="grid gap-2 rounded-md border p-3" data-testid="builder-issues">
        <h2 id="builder-issues" className="text-sm font-semibold">
          {l["builder.issues_title"]}
        </h2>
        {shown.length === 0 ? (
          <p className="text-sm">{l["builder.no_issues"]}</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {shown.map((x, n) => (
              <li key={n} data-issue={x.issue.code} className={x.issue.severity === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-400"}>
                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => setSelected(x.node ?? TRIGGER)}>
                  <span className="font-medium">{x.issue.severity === "error" ? l["editor.issue_error"] : l["editor.issue_warning"]}</span>
                  {`: ${keyOf(x.node)}: ${issueText(x.issue, l)}`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)_minmax(0,26rem)]">
        <BlockPalette onAdd={addToActiveLane} laneName={laneName(activeLane)} disabled={readOnly} l={l} />
        <section aria-label={l["builder.canvas_label"]} className="grid content-start gap-3 rounded-lg border bg-muted/20 p-3" data-testid="builder-canvas">
          <BlockCard
            block="trigger"
            title={l["builder.block.trigger"] ?? ""}
            summary={triggerSummary(graph.trigger, l)}
            issueCount={issueCounts[TRIGGER] ?? 0}
            selected={selected === TRIGGER}
            readOnly={readOnly}
            onSelect={() => setSelected(TRIGGER)}
            l={l}
          />
          <Lane blocks={graph.blocks} path={[]} label={l["builder.lane_main"] ?? ""} api={api} />
        </section>
        <aside aria-labelledby="builder-panel-title" className="grid content-start gap-3 rounded-lg border p-3" data-testid="builder-panel">
          <h2 id="builder-panel-title" className="text-sm font-semibold">
            {selected === TRIGGER ? l["builder.block.trigger"] : selectedNode ? `${l["builder.panel_title"]}: ${selectedNode.step.key}` : l["builder.panel_title"]}
          </h2>
          {selected === TRIGGER ? (
            <TriggerPanel
              trigger={graph.trigger}
              onChange={(patch, drop = []) =>
                change((g) => {
                  const next = { ...(g.trigger as unknown as Obj), ...patch };
                  for (const k of drop) delete next[k];
                  delete next.steps;
                  return { ...g, trigger: next as unknown as BuilderTrigger };
                })
              }
              triggerIssues={triggerIssues}
              l={l}
              options={options}
              readOnly={readOnly}
              issues={[]}
            />
          ) : selectedNode ? (
            <NodePanel
              key={selectedNode.id}
              node={selectedNode}
              onChange={(n) => change((g) => ({ ...g, blocks: replaceNode(g.blocks, selectedNode.id, () => n) }))}
              onInsertAfter={(step) => {
                const where = locate(graph.blocks, selectedNode.id);
                if (where) insertNode(where.path, where.index + 1, nodeFromStep(step));
              }}
              onRemove={() => api.onRemove(selectedNode.id)}
              laterKeys={laterKeys}
              allKeys={keys}
              l={l}
              options={options}
              readOnly={readOnly}
              issues={nodeIssues}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{l["builder.panel_empty"]}</p>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The Trigger block's one-line summary: the event kinds, the segment or "manual". */
function triggerSummary(t: BuilderTrigger, l: Labels): string {
  const trig = (t as unknown as Obj).trigger;
  if (!trig || typeof trig !== "object" || Array.isArray(trig)) return "";
  if ("event" in trig) return ([] as Json[]).concat(trig.event ?? []).map(String).join(", ");
  if ("segment_enter" in trig) return l["editor.trigger_segment"] ?? "segment";
  if ("manual" in trig) return l["editor.trigger_manual"] ?? "manual";
  return "";
}
