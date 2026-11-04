/**
 * The cut-over checklist (ops rule 53): 17 steps, in order. `mode` says how a step is ticked:
 * `gate` mirrors platform's `isGoLiveGateComplete()`, `manual` is ticked by a `settings.write`
 * user, `import` is ticked when a `done` import of `importKind` exists (`packages_reconciled`
 * also needs the sign-off), `stats` when a nightly stats run finished after the last import.
 */
import type { ImportKind } from "./import-targets";

export const CUTOVER_STEPS = [
  "go_live_gate_complete",
  "invoice_issuer_settings_complete",
  "legal_texts_reviewed",
  "dpia_sensitive_processing_decided",
  "suppressions_imported",
  "persons_imported",
  "consents_imported",
  "tags_imported",
  "companies_imported",
  "history_imported",
  "packages_imported",
  "packages_reconciled",
  "memberships_imported",
  "future_bookings_imported",
  "stats_recomputed",
  "old_tools_frozen",
  "dns_switched",
] as const;
export type CutoverKey = (typeof CUTOVER_STEPS)[number];

export type CutoverStepRule =
  | { mode: "gate" }
  | { mode: "manual" }
  | { mode: "import"; importKind: ImportKind; needsSignOff?: true }
  | { mode: "stats" };

export const CUTOVER_RULES: Readonly<Record<CutoverKey, CutoverStepRule>> = {
  go_live_gate_complete: { mode: "gate" },
  invoice_issuer_settings_complete: { mode: "manual" },
  legal_texts_reviewed: { mode: "manual" },
  dpia_sensitive_processing_decided: { mode: "manual" },
  suppressions_imported: { mode: "import", importKind: "suppressions" },
  persons_imported: { mode: "import", importKind: "persons" },
  consents_imported: { mode: "import", importKind: "consents" },
  tags_imported: { mode: "import", importKind: "tags" },
  companies_imported: { mode: "import", importKind: "companies" },
  history_imported: { mode: "import", importKind: "history" },
  packages_imported: { mode: "import", importKind: "packages" },
  packages_reconciled: { mode: "import", importKind: "packages", needsSignOff: true },
  memberships_imported: { mode: "import", importKind: "memberships" },
  future_bookings_imported: { mode: "import", importKind: "bookings" },
  stats_recomputed: { mode: "stats" },
  old_tools_frozen: { mode: "manual" },
  dns_switched: { mode: "manual" },
};

/** Steps a user may tick or untick by hand (`setCutoverStep`). */
export const MANUAL_CUTOVER_STEPS: readonly CutoverKey[] = CUTOVER_STEPS.filter((k) => CUTOVER_RULES[k].mode === "manual");

/** Rule 53: kinds that may not run before `suppressions_imported` unless the user confirms. */
export const NEEDS_SUPPRESSIONS_FIRST: readonly ImportKind[] = ["persons", "consents"];
