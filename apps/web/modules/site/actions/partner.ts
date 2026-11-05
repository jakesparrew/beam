"use server";
/**
 * site server actions, R3 partner landing pages (site spec section 4, 5; site-P9). A landing page
 * linked to a partner company (`pages.partner_company_id`, crm `companies`) passes the partner to
 * its form embeds (`context.partnerCompanyId`), so forms stamps the partner on the leads.
 * `setPagePartner` needs `site.publish` (it changes what the live page sends) and is audited as
 * `site.page.set_partner`; the page's caches are revalidated after the commit.
 * `getPagePartnerOptions` feeds the editor's picker (`site.edit`). Only `landing` pages take a
 * partner (check `partner_company_id is null or kind = 'landing'`).
 */
import { z } from "zod";
import { pages } from "@beam/db/schema";
import { action, type ActionResult } from "@/lib/action";
import { eq, NotFoundError, ValidationError } from "@/lib/ctx";
import { getCompany, listPartnerCompanies } from "@/modules/crm/api";
import { pageTags, revalidateSite } from "../server/cache";

const uuid = z.string().uuid();

export type PagePartnerOptions = {
  kind: string;
  current: { id: string; name: string } | null;
  options: { id: string; name: string }[];
};

type SetPartnerResult = { pageId: string; partnerCompanyId: string | null; changed: boolean };

const setPagePartnerAction = action(
  { name: "site.page.set_partner", audience: "staff", permission: "site.publish", input: z.object({ pageId: uuid, companyId: uuid.nullable() }) },
  async (ctx, input): Promise<SetPartnerResult> => {
    const tx = ctx.tx;
    const [page] = await tx.select({ id: pages.id, kind: pages.kind, partnerCompanyId: pages.partnerCompanyId }).from(pages).where(eq(pages.id, input.pageId)).for("update");
    if (!page) throw new NotFoundError("page_not_found");
    if (input.companyId !== null && page.kind !== "landing") throw new ValidationError("partner_landing_only", { companyId: "landing_only" });
    if (input.companyId !== null && !(await getCompany(tx, input.companyId))) throw new ValidationError("partner_not_found", { companyId: "not_found" });
    if (page.partnerCompanyId === input.companyId) return { pageId: page.id, partnerCompanyId: page.partnerCompanyId, changed: false };
    await tx.update(pages).set({ partnerCompanyId: input.companyId, updatedAt: new Date() }).where(eq(pages.id, page.id));
    await ctx.audit({
      action: "site.page.set_partner",
      entityType: "page",
      entityId: page.id,
      oldValue: { partnerCompanyId: page.partnerCompanyId },
      newValue: { partnerCompanyId: input.companyId },
    });
    return { pageId: page.id, partnerCompanyId: input.companyId, changed: true };
  },
);

/** Links a landing page to a partner company, or unlinks it with `companyId: null`. */
export async function setPagePartner(raw: { pageId: string; companyId: string | null }): Promise<ActionResult<SetPartnerResult>> {
  const result = await setPagePartnerAction(raw);
  if (result.ok && result.data.changed) revalidateSite(pageTags(result.data.pageId));
  return result;
}

const getPagePartnerOptionsAction = action(
  { name: "site.page.partner_options", audience: "staff", permission: "site.edit", input: z.object({ pageId: uuid }), audit: false },
  async (ctx, input): Promise<PagePartnerOptions> => {
    const [page] = await ctx.tx.select({ kind: pages.kind, partnerCompanyId: pages.partnerCompanyId }).from(pages).where(eq(pages.id, input.pageId));
    if (!page) throw new NotFoundError("page_not_found");
    const partners = (await listPartnerCompanies(ctx.tx)).map((c) => ({ id: c.id, name: c.name }));
    let current: PagePartnerOptions["current"] = null;
    if (page.partnerCompanyId) {
      const company = partners.find((c) => c.id === page.partnerCompanyId) ?? (await getCompany(ctx.tx, page.partnerCompanyId));
      current = company ? { id: company.id, name: company.name } : null;
    }
    const options = current && !partners.some((c) => c.id === current.id) ? [current, ...partners] : partners;
    return { kind: page.kind, current, options };
  },
);

/** The page's partner and the partner companies the editor's picker offers. */
export async function getPagePartnerOptions(raw: { pageId: string }): Promise<ActionResult<PagePartnerOptions>> {
  return getPagePartnerOptionsAction(raw);
}
