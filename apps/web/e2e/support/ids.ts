/** A unique test address: `e2e+<tag>-<timestamp36>-<rand>@example.com` (runbook 3.6). */
export function uniqueEmail(tag: string): string {
  const safe = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e+${safe}-${Date.now().toString(36)}-${rand}@example.com`;
}
