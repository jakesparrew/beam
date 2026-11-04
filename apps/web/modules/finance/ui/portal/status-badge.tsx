/** The status of a portal document as a badge with text (never colour alone, WCAG 2.1 AA). */
import { Badge } from "@beam/ui";
import type { MyInvoiceRow } from "../../queries";

const VARIANT: Record<MyInvoiceRow["status"], "success" | "warning" | "outline" | "secondary"> = {
  paid: "success",
  open: "warning",
  cancelled: "outline",
  issued: "secondary",
};

export function PortalStatusBadge({ status, label }: { kind: MyInvoiceRow["kind"]; status: MyInvoiceRow["status"]; label: string }) {
  return (
    <Badge variant={VARIANT[status]} data-status={status}>
      {label}
    </Badge>
  );
}
