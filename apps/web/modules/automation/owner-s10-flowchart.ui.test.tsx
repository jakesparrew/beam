/**
 * Owner's review, section 10 (automations as flowcharts): the overview draws the trigger on top,
 * every step as a box (waits dashed, questions in amber with Yes and No lanes), and each box links
 * to the visual builder on that step when the viewer may edit.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Definition } from "@beam/core/automation";
import { AutomationFlowchart } from "./ui/flowchart";

const def: Definition = {
  schema_version: 1,
  trigger: { event: "booking.confirmed" },
  anchor: "enrolment",
  re_entry: "always",
  exit_on: [],
  steps: [
    { key: "pause", type: "wait", minutes: 60 },
    { key: "member", type: "condition", if: { status_in: ["member"] }, then: "thanks", else: "offer" },
    { key: "thanks", type: "tag", tag: "vip" },
    { key: "offer", type: "email", template: "membership-offer" },
  ],
};
const l = { "detail.flow_when": "When", "detail.flow_end": "The end", "builder.lane_then": "Yes", "builder.lane_else": "No", "builder.block.delay": "Delay", "builder.block.branch": "Branch", "builder.block.email": "Send email" };

const render = (builderHref?: string) => renderToStaticMarkup(createElement(AutomationFlowchart, { definition: def, triggerText: "When booking.confirmed happens", l, builderHref }));

describe("automation flowchart", () => {
  it("draws the trigger, the steps and the Yes and No lanes of a branch", () => {
    const out = render();
    expect(out.indexOf("When booking.confirmed happens")).toBeLessThan(out.indexOf('data-testid="flow-step-pause"'));
    expect(out).toMatch(/class="[^"]*border-dashed[^"]*" data-testid="flow-step-pause"/);
    expect(out).toContain('data-testid="flow-branch-member"');
    expect(out).toMatch(/data-lane="then".*flow-step-thanks.*data-lane="else".*flow-step-offer/s);
    // "No" skips the tag and continues with the email after the branch.
    expect(out).not.toMatch(/data-lane="else"[^]*flow-step-thanks/);
    expect(out).toContain("membership-offer");
    expect(out).toContain("The end");
    expect(out).not.toContain("<a ");
  });

  it("links every box to the builder with the step selected", () => {
    const out = render("/admin/automations/x/builder");
    expect(out).toContain('href="/admin/automations/x/builder?step=offer"');
    expect(out).toContain('href="/admin/automations/x/builder"');
  });
});
