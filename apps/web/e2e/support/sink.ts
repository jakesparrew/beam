import { sql } from "drizzle-orm";
import { e2eRows } from "./db";

export type SinkEmail = { subject: string; html: string; links: string[]; createdAt: Date };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `href` values of an HTML body, entity-decoded. */
export function extractLinks(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*"([^"]+)"/gi)].map((m) => m[1]!.replace(/&amp;/g, "&").replace(/&#x3D;/gi, "=").replace(/&#61;/g, "="));
}

/**
 * The newest email sent to `to` (the real address; the sink rewrites the recipient), read from
 * `files` (kind `rendered_email`) joined to `email_messages.to_email`. Polls every 500 ms for up
 * to 15 s (runbook 3.6). `after` ignores older messages; `subjectIncludes` filters the subject;
 * `linkIncludes` keeps only messages with a link containing it (another email to the same person,
 * an invoice or a credit note, may arrive in the same seconds).
 */
export async function latestEmail(to: string, opts: { after?: Date; subjectIncludes?: string; linkIncludes?: string; timeoutMs?: number } = {}): Promise<SinkEmail> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const after = (opts.after ?? new Date(0)).toISOString();
  for (;;) {
    const rows = await e2eRows<{ subject: string | null; bytes: Uint8Array | Buffer | string; created_at: string | Date }>(sql`
      select m.subject, f.bytes, f.created_at
      from email_messages m
      join files f on f.id = m.rendered_file_id and f.kind = 'rendered_email'
      where lower(m.to_email) = ${to.toLowerCase()} and f.created_at > ${after}::timestamptz
        and (${opts.subjectIncludes ?? null}::text is null or m.subject ilike '%' || ${opts.subjectIncludes ?? ""} || '%')
      order by f.created_at desc
      limit 10`);
    for (const row of rows) {
      const html = typeof row.bytes === "string" ? Buffer.from(row.bytes.replace(/^\\x/, ""), "hex").toString("utf8") : Buffer.from(row.bytes).toString("utf8");
      const links = extractLinks(html);
      if (opts.linkIncludes && !links.some((l) => l.includes(opts.linkIncludes!))) continue;
      return { subject: row.subject ?? "", html, links, createdAt: new Date(row.created_at) };
    }
    if (Date.now() > deadline) throw new Error(`No email to ${to} arrived in the sink within ${opts.timeoutMs ?? 15_000} ms`);
    await sleep(500);
  }
}
