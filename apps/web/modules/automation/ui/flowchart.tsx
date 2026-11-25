"use client";
/**
 * The read-only flowchart of a definition on `/admin/automations/[id]` (owner's review, section
 * 10: "present automations visually as flowcharts"). The trigger sits at the top, every step is a
 * box joined by arrows: delays as dashed boxes, conditions and branches in amber with their "Yes"
 * and "No" lanes side by side, actions with the builder's colour per block. With `builderHref`,
 * every box links to the visual builder with that step selected (`?step=<key>`), where it is
 * edited. Pure HTML and CSS over `definitionToGraph`; every string arrives through `l`.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { definitionToGraph, type BranchLane, type BuilderNode, type Definition } from "@beam/core/automation";
import { describeAt } from "./automation-table";
import { ACCENT, blockOf, blockSummary } from "./builder/block";
import { fill, type Labels } from "./outcome-badge";

type Ctx = { l: Labels; href?: (stepKey?: string) => string };

const LANE_COLOUR = {
  then: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  else: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100",
} as const;

/** A vertical connector with an arrowhead. */
function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center" aria-hidden={label ? undefined : true}>
      <span className="h-4 w-px bg-border" />
      {label ? <span className="rounded-full border bg-background px-2 text-xs font-medium text-muted-foreground">{label}</span> : null}
      <span className={label ? "h-3 w-px bg-border" : "hidden"} />
      <svg width="10" height="6" viewBox="0 0 10 6" className="fill-border" aria-hidden="true">
        <path d="M0 0 L10 0 L5 6 Z" />
      </svg>
    </div>
  );
}

/** A box; a link to the builder when the viewer may edit. */
function Box({ children, className, stepKey, ctx, testId }: { children: ReactNode; className: string; stepKey?: string; ctx: Ctx; testId: string }) {
  const cls = `block w-full max-w-sm rounded-md border bg-card px-3 py-2 text-left text-sm shadow-sm ${className}`;
  if (!ctx.href) return <div className={cls} data-testid={testId}>{children}</div>;
  return (
    <Link href={ctx.href(stepKey) as never} className={`${cls} outline-none hover:ring-2 hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-ring`} data-testid={testId}>
      {children}
    </Link>
  );
}

function Terminal({ text }: { text: string }) {
  return <span className="rounded-full border border-dashed px-3 py-1 text-xs text-muted-foreground">{text}</span>;
}

function NodeBox({ node, ctx }: { node: BuilderNode; ctx: Ctx }) {
  const { l } = ctx;
  const block = blockOf(node);
  const summary = blockSummary(node, l);
  const at = node.step.at ? describeAt(node.step.at, l) : "";
  const isDelay = block === "delay";
  const isQuestion = node.kind !== "step";
  return (
    <Box
      ctx={ctx}
      stepKey={node.step.key}
      testId={`flow-step-${node.step.key}`}
      className={isDelay ? "border-dashed bg-muted/30" : isQuestion ? "border-amber-500 bg-amber-50 dark:bg-amber-950/30" : `border-l-4 ${ACCENT[block]}`}
    >
      <span className="flex items-center gap-2 font-semibold">
        <span aria-hidden="true">{isDelay ? "⏱" : isQuestion ? "◆" : "▸"}</span>
        {l[`builder.block.${block}`] ?? block}
      </span>
      {summary ? <span className="block text-muted-foreground">{isQuestion ? `${summary}?` : summary}</span> : null}
      {at ? <span className="block text-xs text-muted-foreground">{at}</span> : null}
    </Box>
  );
}

function LaneEnd({ lane, ctx }: { lane: BranchLane; ctx: Ctx }) {
  if (lane.blocks.length) return null;
  if (lane.end) return <Terminal text={ctx.l["builder.lane_end"] ?? ""} />;
  if (lane.goto) return <Terminal text={fill(ctx.l["builder.lane_goto"], { key: lane.goto })} />;
  return <Terminal text={ctx.l["builder.lane_continue"] ?? ""} />;
}

function Flow({ blocks, ctx }: { blocks: BuilderNode[]; ctx: Ctx }) {
  return (
    <>
      {blocks.map((node) => (
        <div key={node.id} className="flex w-full flex-col items-center">
          <Arrow />
          <NodeBox node={node} ctx={ctx} />
          {node.kind === "condition" ? (
            <div className="flex w-full max-w-sm justify-end pt-1">
              <span className="text-xs text-muted-foreground">{`${ctx.l["builder.lane_else"]}: ${ctx.l["builder.lane_end"]}`}</span>
            </div>
          ) : null}
          {node.kind === "branch" ? (
            <div className="grid w-full grid-cols-2 gap-3 border-t border-border pt-1" data-testid={`flow-branch-${node.step.key}`}>
              {(["then", "else"] as const).map((lane) => (
                <div key={lane} className="flex flex-col items-center rounded-md bg-muted/20 pb-2" data-lane={lane}>
                  <span className={`mt-1 rounded-full px-2 text-xs font-semibold ${LANE_COLOUR[lane]}`}>{ctx.l[`builder.lane_${lane}`]}</span>
                  <Flow blocks={node[lane].blocks} ctx={ctx} />
                  {node[lane].blocks.length === 0 ? <Arrow /> : null}
                  <LaneEnd lane={node[lane]} ctx={ctx} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

export function AutomationFlowchart({ definition, triggerText, l, builderHref }: { definition: Definition; triggerText: string; l: Labels; builderHref?: string }) {
  const graph = definitionToGraph(definition);
  const ctx: Ctx = { l, href: builderHref ? (key) => (key ? `${builderHref}?step=${encodeURIComponent(key)}` : builderHref) : undefined };
  return (
    <figure className="grid gap-2" aria-label={l["detail.flow_title"]} data-testid="automation-flowchart">
      <div className="flex flex-col items-center overflow-x-auto rounded-lg border bg-muted/10 p-4">
        <Box ctx={ctx} testId="flow-trigger" className="rounded-full border-primary text-center">
          <span className="block text-xs font-semibold uppercase tracking-wide text-primary">{l["detail.flow_when"]}</span>
          <span className="block">{triggerText}</span>
        </Box>
        <Flow blocks={graph.blocks} ctx={ctx} />
        <Arrow />
        <Terminal text={l["detail.flow_end"] ?? ""} />
      </div>
      {builderHref ? <figcaption className="text-xs text-muted-foreground">{l["detail.flow_hint"]}</figcaption> : null}
    </figure>
  );
}
