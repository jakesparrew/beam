/**
 * Semantic validation of a parsed definition (A-1, A-3, A-4; edge cases 17, 22, 35). Pure: the
 * caller loads the references (`ValidationRefs`) from the database. Errors block publishing;
 * warnings (unknown event kinds or paths) are shown in the editor only.
 */
import { walkCondition } from "./conditions";
import {
  DEFINITION_LOCALES,
  isEventTrigger,
  triggerKinds,
  type AutomationPurpose,
  type Condition,
  type Definition,
  type DefinitionIssue,
  type DefinitionLocale,
  type Filter,
  type ReEntry,
} from "./definition";
import { HISTORY_IMPORTED_KIND, isPlaceholder } from "./filter";
import { checkWebhookUrl } from "./webhook";

/** Every issue code `parseDefinition` and `validateDefinition` produce (catalogue `automation.issue.<code>`). */
export const DEFINITION_ISSUE_CODES = [
  "invalid_definition",
  "unknown_key",
  "duplicate_step_key",
  "branch_target_unknown",
  "branch_backward",
  "template_unavailable",
  "template_purpose_mismatch",
  "translation_missing",
  "send_as_not_marketing",
  "automation_unknown",
  "enrol_self",
  "enrol_cycle",
  "tag_unknown",
  "role_unknown",
  "webhook_not_https",
  "webhook_host_not_allowed",
  "anchor_required",
  "exclusive_subject",
  "trigger_history_imported",
  "trigger_automation_kind",
  "placeholder_not_allowed",
  "interpolation_not_allowed",
  "unknown_event_kind",
  "unknown_event_path",
] as const;
export type DefinitionIssueCode = (typeof DEFINITION_ISSUE_CODES)[number];

export type TemplateRef = {
  kind: "transactional" | "marketing";
  purpose: AutomationPurpose | null;
  /** Locales of the current published version. */
  locales: readonly string[];
};

export type ValidationRefs = {
  /** The automation being validated. */
  automation: { slug: string; isMarketing: boolean; purpose: AutomationPurpose | null; isExclusiveGroup: boolean };
  /** Published templates by slug (absent = unpublished or unknown). */
  templates: Readonly<Record<string, TemplateRef>>;
  /** Other automations by slug: their re-entry policy and the slugs their `enrol` steps target. */
  automations: Readonly<Record<string, { reEntry: ReEntry; enrolTargets: readonly string[] }>>;
  /** `tags.key` values. */
  tags: readonly string[];
  /** Seeded role keys. */
  roles: readonly string[];
  /** `settings.automation_rules.webhook_hosts`. */
  webhookHosts: readonly string[];
  /** Known `data` keys per event kind (edge case 22); kinds absent here are not checked. */
  eventDataPaths?: Readonly<Record<string, readonly string[]>>;
};

const SLACK_PLACEHOLDERS = new Set(["{{first_name}}", "{{person_url}}", "{{automation}}"]);
const TASK_PLACEHOLDER_RE = /^\{\{trigger\.data\.[a-z0-9_]+\}\}$/;
const PLACEHOLDER_SCAN_RE = /\{\{[^}]*\}\}/g;

type Push = (code: DefinitionIssueCode, path: string, message: string, params?: DefinitionIssue["params"], severity?: DefinitionIssue["severity"]) => void;

function filterHasPlaceholder(f: Filter | undefined): boolean {
  if (!f) return false;
  return Object.values(f).some((v) => {
    if (isPlaceholder(v)) return true;
    if (v !== null && typeof v === "object") {
      return Object.values(v).some((x) => (Array.isArray(x) ? x.some(isPlaceholder) : isPlaceholder(x)));
    }
    return false;
  });
}

function checkCondition(c: Condition, path: string, push: Push, refs: ValidationRefs, stepKeys: Set<string>): void {
  walkCondition(c, (node) => {
    if ("has_tag" in node && !refs.tags.includes(node.has_tag)) push("tag_unknown", path, `tag ${node.has_tag} does not exist`, { tag: node.has_tag });
    if ("trigger" in node && filterHasPlaceholder(node.trigger))
      push("interpolation_not_allowed", path, "{{trigger.data.*}} is not allowed in a trigger condition");
    if ("task_open" in node && !stepKeys.has(node.task_open))
      push("branch_target_unknown", path, `task_open names no step ${node.task_open}`, { target: node.task_open });
    if ("sent_within_days" in node && !refs.templates[node.sent_within_days.template])
      push("template_unavailable", path, `template ${node.sent_within_days.template} is not published`, { template: node.sent_within_days.template });
  });
}

function checkDataPaths(kinds: string[], where: Filter | undefined, path: string, push: Push, refs: ValidationRefs) {
  if (!refs.eventDataPaths) return;
  for (const kind of kinds) {
    const known = refs.eventDataPaths[kind];
    if (!known) {
      push("unknown_event_kind", path, `event kind ${kind} is not in the event registry`, { kind }, "warning");
      continue;
    }
    for (const p of Object.keys(where ?? {})) {
      if (!p.startsWith("data.")) continue;
      const top = p.slice(5).split(".")[0]!;
      if (!known.includes(top)) push("unknown_event_path", path, `${kind} has no data path ${p}`, { kind, path: p }, "warning");
    }
  }
}

/** A-1, A-3, A-4: every finding for a parsed definition; an empty list means publishable. */
export function validateDefinition(def: Definition, ref: ValidationRefs): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const push: Push = (code, path, message, params, severity = "error") =>
    issues.push(params ? { code, path, message, severity, params } : { code, path, message, severity });
  const self = ref.automation;

  // Trigger (A-1, A-7, ops rule 47b).
  const kinds = triggerKinds(def.trigger);
  if (isEventTrigger(def.trigger)) {
    for (const kind of kinds) {
      if (kind === HISTORY_IMPORTED_KIND) push("trigger_history_imported", "trigger.event", "imported history never starts a journey", { kind });
      else if (kind.startsWith("automation.")) push("trigger_automation_kind", "trigger.event", "automation events never trigger", { kind });
    }
    if (filterHasPlaceholder(def.trigger.where))
      push("interpolation_not_allowed", "trigger.where", "{{trigger.data.*}} is not allowed in a trigger filter");
    checkDataPaths(kinds, def.trigger.where, "trigger.where", push, ref);
  }
  if (self.isExclusiveGroup && def.subject === "ref")
    push("exclusive_subject", "subject", "an automation in an exclusive group cannot set a subject");

  def.exit_on.forEach((entry, i) => {
    if (typeof entry !== "string") checkDataPaths([entry.event], entry.where, `exit_on.${i}`, push, ref);
  });

  // Steps.
  const keys = def.steps.map((s) => s.key);
  const stepKeys = new Set(keys);
  const locales: readonly DefinitionLocale[] = def.audience?.locales ?? DEFINITION_LOCALES;
  def.steps.forEach((step, i) => {
    const p = `steps.${i}`;
    if (step.at?.from === "anchor" && def.anchor === "enrolment")
      push("anchor_required", `${p}.at.from`, `step ${step.key} is timed from the anchor but the anchor is the enrolment`);
    if (step.unless) checkCondition(step.unless, `${p}.unless`, push, ref, stepKeys);

    switch (step.type) {
      case "condition": {
        checkCondition(step.if, `${p}.if`, push, ref, stepKeys);
        for (const branch of ["then", "else"] as const) {
          const target = step[branch];
          if (target === "end") continue;
          const t = keys.indexOf(target);
          if (t < 0) push("branch_target_unknown", `${p}.${branch}`, `no step ${target}`, { target });
          else if (t <= i) push("branch_backward", `${p}.${branch}`, `${branch} must point to a later step or end`, { target });
        }
        break;
      }
      case "email": {
        const tpl = ref.templates[step.template];
        if (step.send_as === "marketing" && (!self.isMarketing || self.purpose === null))
          push("send_as_not_marketing", `${p}.send_as`, "send_as marketing needs a marketing automation with a purpose");
        if (!tpl) {
          push("template_unavailable", `${p}.template`, `template ${step.template} is not published`, { template: step.template });
          break;
        }
        if (tpl.kind === "marketing" && self.purpose !== null && tpl.purpose !== null && tpl.purpose !== self.purpose)
          push("template_purpose_mismatch", `${p}.template`, `template purpose ${tpl.purpose} differs from ${self.purpose}`, {
            template: step.template,
            purpose: tpl.purpose,
          });
        const missing = locales.filter((l) => !tpl.locales.includes(l));
        if (missing.length > 0)
          push("translation_missing", `${p}.template`, `template ${step.template} misses ${missing.join(", ")}`, {
            template: step.template,
            locales: missing,
          });
        break;
      }
      case "task": {
        if (!ref.roles.includes(step.owner_role)) push("role_unknown", `${p}.owner_role`, `role ${step.owner_role} does not exist`, { role: step.owner_role });
        for (const m of step.title.match(PLACEHOLDER_SCAN_RE) ?? [])
          if (!TASK_PLACEHOLDER_RE.test(m)) push("placeholder_not_allowed", `${p}.title`, `placeholder ${m} is not allowed`, { placeholder: m });
        break;
      }
      case "tag":
      case "untag":
        if (!ref.tags.includes(step.tag)) push("tag_unknown", `${p}.tag`, `tag ${step.tag} does not exist`, { tag: step.tag });
        break;
      case "enrol": {
        if (step.automation === self.slug) {
          push("enrol_self", `${p}.automation`, "an automation cannot enrol into itself");
          break;
        }
        const target = ref.automations[step.automation];
        if (!target) push("automation_unknown", `${p}.automation`, `no automation ${step.automation}`, { slug: step.automation });
        else if (target.reEntry === "always" && target.enrolTargets.includes(self.slug))
          push("enrol_cycle", `${p}.automation`, `${step.automation} enrols back into ${self.slug} with re-entry always`, { slug: step.automation });
        break;
      }
      case "exit":
        if (step.automation && step.automation !== self.slug && !ref.automations[step.automation])
          push("automation_unknown", `${p}.automation`, `no automation ${step.automation}`, { slug: step.automation });
        break;
      case "notify_slack":
        for (const m of step.text.match(PLACEHOLDER_SCAN_RE) ?? [])
          if (!SLACK_PLACEHOLDERS.has(m)) push("placeholder_not_allowed", `${p}.text`, `placeholder ${m} is not allowed`, { placeholder: m });
        break;
      case "webhook": {
        const check = checkWebhookUrl(step.url, ref.webhookHosts);
        if (!check.https) push("webhook_not_https", `${p}.url`, "webhook URLs must be https");
        else if (!check.allowed) push("webhook_host_not_allowed", `${p}.url`, "the webhook host is not on the allow-list");
        break;
      }
      default:
        break;
    }
  });
  return issues;
}

/** True when no issue is an error (warnings do not block publishing). */
export const isPublishable = (issues: readonly DefinitionIssue[]): boolean => issues.every((i) => i.severity !== "error");

/** Every email template slug a definition references (`isTemplateInUse`, A-3). */
export function referencedTemplates(def: Definition): string[] {
  const out = new Set<string>();
  for (const s of def.steps) {
    if (s.type === "email") out.add(s.template);
    const conds = [s.unless, s.type === "condition" ? s.if : undefined].filter((c): c is Condition => c !== undefined);
    for (const c of conds) walkCondition(c, (n) => ("sent_within_days" in n ? out.add(n.sent_within_days.template) : undefined));
  }
  return [...out].sort();
}

/** Every segment id a definition references: trigger, audience, exclusions, `in_segment` (`isSegmentInUse`). */
export function referencedSegments(def: Definition): string[] {
  const out = new Set<string>();
  if ("segment_enter" in def.trigger) out.add(def.trigger.segment_enter);
  if (def.audience?.segment_id) out.add(def.audience.segment_id);
  for (const id of def.audience?.exclude_segment_ids ?? []) out.add(id);
  for (const s of def.steps) {
    const conds = [s.unless, s.type === "condition" ? s.if : undefined].filter((c): c is Condition => c !== undefined);
    for (const c of conds) walkCondition(c, (n) => ("in_segment" in n ? out.add(n.in_segment) : undefined));
  }
  return [...out].sort();
}

/** The automation slugs a definition's `enrol` steps target (edge case 17). */
export const enrolTargets = (def: Definition): string[] =>
  [...new Set(def.steps.flatMap((s) => (s.type === "enrol" ? [s.automation] : [])))].sort();
