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
      className={cn("rounded-2xl p-4 text-sm", tone === "warning" ? "bg-[#fdf3dc]" : "bg-[#f6efdf]")}
      data-testid="policy-note"
    >
      <p>{policy}</p>
      {notice ? <p className="mt-1 text-muted-foreground">{notice}</p> : null}
    </div>
  );
}
