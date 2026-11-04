/**
 * The cancellation policy note of the portal booking form and booking page (booking spec 5.2,
 * R28, R29): "Free cancellation until Tue 14 Jan 18:00" or "Cancelling now keeps the session
 * used", plus the no-withdrawal notice for dated services on the booking form. Texts come from
 * the page, already formatted in Brussels time.
 */
import { cn } from "@beam/ui";

export function PolicyNote({ policy, notice, tone = "info" }: { policy: string; notice?: string | null; tone?: "info" | "warning" }) {
  return (
    <div
      className={cn("rounded-md border p-3 text-sm", tone === "warning" ? "border-warning bg-warning/10" : "bg-muted/40")}
      data-testid="policy-note"
    >
      <p>{policy}</p>
      {notice ? <p className="mt-1 text-muted-foreground">{notice}</p> : null}
    </div>
  );
}
