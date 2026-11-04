/**
 * Status badges of finance's back-office tables (finance spec section 5, accessibility: every
 * badge carries its text, colour is never the only signal). Works in server and client components.
 */
import { Badge } from "@beam/ui";
import type { FinanceLabels } from "./text";

type Variant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning";

const STATUS_VARIANT: Record<string, Variant> = {
  paid: "success",
  open: "warning",
  issued: "secondary",
  cancelled: "outline",
  synced: "success",
  sent: "success",
  rendered: "success",
  pending: "secondary",
  failed: "destructive",
  not_applicable: "outline",
  requested: "warning",
  approved: "success",
  rejected: "outline",
  ok: "success",
  issues: "warning",
};

/** A badge for `value` labelled from `<group>.<value>` (for example `status.paid`). */
export function FinanceBadge({ group, value, labels }: { group: string; value: string; labels: FinanceLabels }) {
  return <Badge variant={STATUS_VARIANT[value] ?? "outline"}>{labels[`${group}.${value}`] ?? value}</Badge>;
}
