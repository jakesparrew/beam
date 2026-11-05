/** A unique test address: `e2e+<tag>-<timestamp36>-<rand>@example.com` (runbook 3.6). */
export function uniqueEmail(tag: string): string {
  const safe = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e+${safe}-${Date.now().toString(36)}-${rand}@example.com`;
}

/**
 * A unique address whose normalised form is unique too: `e2e-<tag>-<timestamp36>-<rand>@example.com`.
 * Booking's duplicate signals drop the `+` part (`e2e+a@...` and `e2e+b@...` are both `e2e@...`), so
 * people who meet on one lead-magnet session or waitlist need this form (booking R48).
 */
export function distinctEmail(tag: string): string {
  return uniqueEmail(tag).replace(/^e2e\+/, "e2e-");
}
