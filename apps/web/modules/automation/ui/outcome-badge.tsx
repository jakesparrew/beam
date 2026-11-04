/**
 * Badges for run outcomes and automation statuses (automation spec 5: "outcome badge (colour per
 * outcome family)"; WCAG: the badge always carries its text, the colour only repeats it), plus
 * the small helpers the automation screens share on server and client: `Labels` (catalogue
 * strings under `automation.` passed as props), `fill` for `{name}` slots and `errorText` for an
 * action error in the catalogue's words. No hooks, so it renders in server and client components.
 */
import { Badge } from "@beam/ui";
import type { AutomationRunOutcome } from "@beam/core/automation";

/** Catalogue strings keyed without the `automation.` prefix (`editor.save`, `outcome.sent`). */
export type Labels = Record<string, string>;

/** Fills `{name}` slots of a simple message (no plurals; those are formatted on the server). */
export function fill(template: string | undefined, params: Record<string, string | number> = {}): string {
  return (template ?? "").replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

export type ActionResultLike<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

/**
 * The words for an action error: `errors.<name>` for a specific message (`dpia_not_approved:<key>`
 * fills `{key}`), else the code's text, else the generic one.
 */
export function errorText(error: { code: string; message: string }, l: Labels): string {
  const [name, ...rest] = error.message.split(":");
  const param = rest.join(":");
  if (name && l[`errors.${name}`]) return fill(l[`errors.${name}`], { key: param });
  return l[`errors.${error.code}`] ?? l["errors.generic"] ?? error.message;
}

export type IssueLike = { code: string; path: string; message: string; severity: "error" | "warning"; params?: Record<string, string | number | string[]> };

/** An issue in the catalogue's words (`issue.<code>`), with the template, slug, tag or role it names. */
export function issueText(issue: IssueLike, l: Labels): string {
  const base = l[`issue.${issue.code}`] ?? issue.message;
  const p = issue.params ?? {};
  const named = p.template ?? p.slug ?? p.tag ?? p.role ?? p.kind ?? p.target;
  const locales = Array.isArray(p.locales) ? ` (${p.locales.join(", ")})` : "";
  return named !== undefined ? `${base} ${String(named)}${locales}` : base;
}

export type OutcomeFamily = "done" | "info" | "skipped" | "failed";

const INFO = new Set<AutomationRunOutcome>(["entered", "scheduled", "branched", "exited"]);

/** done (green): the step did its work; info: journey bookkeeping; skipped (amber); failed (red). */
export function outcomeFamily(outcome: AutomationRunOutcome): OutcomeFamily {
  if (outcome === "failed") return "failed";
  if (outcome.startsWith("skipped_")) return "skipped";
  if (INFO.has(outcome)) return "info";
  return "done";
}

const VARIANT = { done: "success", info: "secondary", skipped: "warning", failed: "destructive" } as const;

export function OutcomeBadge({ outcome, label }: { outcome: AutomationRunOutcome; label: string }) {
  const family = outcomeFamily(outcome);
  return (
    <Badge variant={VARIANT[family]} data-outcome={outcome} data-family={family}>
      {label}
    </Badge>
  );
}

const STATUS_VARIANT = { draft: "outline", active: "success", paused: "warning", archived: "secondary" } as const;

export function AutomationStatusBadge({ status, label }: { status: keyof typeof STATUS_VARIANT; label: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} data-status={status} data-testid="automation-status">
      {label}
    </Badge>
  );
}
