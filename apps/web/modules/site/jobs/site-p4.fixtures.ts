/**
 * Test fixtures of site-P4 (BS-23): a page with a live version and a draft, an edit request, and
 * Claude answers built from a base version (a valid proposal that adds an FAQ block, and invalid
 * variants). Rows are inserted directly; the actions are tested in `actions/proposals.test.ts`.
 */
import { randomUUID } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { pageEditRequests, pages, pageVersions } from "@beam/db/schema";
import { makeUser } from "@beam/db/testing";
import type { Locale } from "@beam/core/i18n";
import { paragraphDoc, type Block, type VersionContent } from "@beam/core/site";
import { eq } from "@/lib/ctx";
import { ALL, publishable, slug } from "../site-p3.fixtures";

export type ProposalPageFixture = { pageId: string; liveId: string; requestId: string; base: VersionContent; requesterId: string };

/** A published standard page (`locales`) with a pending edit request based on its live version. */
export async function pageWithRequest(db: DbOrTx, opts: { locales?: Locale[]; kind?: "standard" | "legal"; instruction?: string; status?: "draft" | "published" | "archived" } = {}): Promise<ProposalPageFixture> {
  const locales = opts.locales ?? ALL;
  const s = slug("prop");
  const content = publishable(s, locales);
  const requester = await makeUser(db, { roleKey: "marketing", name: "Requester Janssens", email: `requester-${randomUUID().slice(0, 8)}@example.com` });
  const [page] = await db
    .insert(pages)
    .values({ kind: opts.kind ?? "standard", slug: s, ...(opts.kind === "legal" ? { legalKey: "accessibility_statement" as const } : {}) })
    .returning();
  const [live] = await db
    .insert(pageVersions)
    .values({ pageId: page!.id, version: 1, state: "published", publishedAt: new Date(), ...content })
    .returning();
  const status = opts.status ?? "published";
  await db.update(pages).set({ status, currentVersionId: live!.id }).where(eq(pages.id, page!.id));
  const [req] = await db
    .insert(pageEditRequests)
    .values({ pageId: page!.id, kind: "edit", instruction: opts.instruction ?? "Add an FAQ about opening hours.", locales, baseVersionId: live!.id, baseUpdatedAt: live!.updatedAt, requestedByUserId: requester.id })
    .returning();
  return { pageId: page!.id, liveId: live!.id, requestId: req!.id, base: { ...content, excerpt: null, coverMediaId: null }, requesterId: requester.id };
}

export function faqBlock(locale: Locale): Block {
  return { id: randomUUID(), type: "faq", heading: `FAQ ${locale}`, items: [{ question: `When are you open? (${locale})`, answer: paragraphDoc("Every day from 9 to 22.") }] };
}

/** A valid Claude answer: the base content with an FAQ block appended to every locale. */
export function validAnswer(base: VersionContent, extra: { changeSummary?: string } = {}): Record<string, unknown> {
  const blocks: Partial<Record<Locale, Block[]>> = {};
  for (const l of base.locales) blocks[l] = [...(base.blocks[l] ?? []), faqBlock(l)];
  return { title: base.title, paths: base.paths, blocks, seo: base.seo, changeSummary: extra.changeSummary ?? "Added an FAQ about opening hours." };
}

/** Parses but fails rule 44: the last locale is dropped. */
export function droppedLocaleAnswer(base: VersionContent): Record<string, unknown> {
  const answer = validAnswer(base);
  const keep = base.locales.slice(0, -1);
  const pick = <T>(o: Partial<Record<Locale, T>>) => Object.fromEntries(keep.map((l) => [l, o[l]]));
  return { ...answer, title: pick(base.title), paths: pick(base.paths), seo: pick(base.seo), blocks: pick(answer.blocks as Partial<Record<Locale, Block[]>>) };
}

/** Does not parse as `ProposalOutput` (unknown block type). */
export function unparsableAnswer(): Record<string, unknown> {
  return { title: { en: "x" }, paths: {}, blocks: { en: [{ id: randomUUID(), type: "marquee", text: "Hi" }] }, seo: {}, changeSummary: "x" };
}
