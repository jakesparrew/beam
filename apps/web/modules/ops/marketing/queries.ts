/**
 * ops queries, area `marketing` (ops spec 4.2, R3): the management dashboard (rules 34-38), the
 * marketing dashboard (rule 75 with the email and webinar summaries), attribution (rules 72-73),
 * the campaign funnel (rule 73a) and the ads report (rule 74). Each takes an `OpsReadCtx` (a page
 * builds it with `staffReadCtx()`), checks `reports.read` on the actor, reads named columns and
 * caps its lists at 50 rows. Reading is not audited (ops spec 7); CSV downloads are.
 *
 * Ranges are Brussels dates, both included (`?from=&to=`, default the last 30 days); the
 * management dashboard takes a rule 34 period instead.
 */
import { type Period } from "@beam/core/ops";
import { parseDateRange, type DateRange } from "../reports/no-shows";
import { requireAny, type OpsReadCtx } from "../reports/registry";
import { computeAdsReport, type AdsReport } from "./ads";
import { computeAttributionReport, type AttributionModel, type AttributionReport } from "./attribution";
import { computeEmailSummary, type EmailSummary } from "./email-summary";
import { computeCampaignFunnel, type CampaignFunnelRow } from "./funnel";
import { computeMarketingKpis, type MarketingKpis } from "./kpis-marketing";
import { computeManagementDashboard, type ManagementDashboard } from "./management";
import { computeWebinarSummary, type WebinarSummary } from "./webinar-summary";
import type { VatMode } from "../reports/revenue";

export type { AdsReport, AttributionModel, AttributionReport, CampaignFunnelRow, EmailSummary, ManagementDashboard, MarketingKpis, WebinarSummary };

export type RangeInput = { from?: string | undefined; to?: string | undefined };

const rangeOf = (ctx: OpsReadCtx, input: RangeInput): DateRange => parseDateRange(input, ctx.now);

/** Rules 34-38 (`reports.read`). */
export async function getManagementDashboard(ctx: OpsReadCtx, input: { period: Period; at: Date; vat?: VatMode }): Promise<ManagementDashboard> {
  requireAny(ctx, "reports.read");
  return computeManagementDashboard(ctx.tx, input);
}

export type MarketingDashboard = { range: DateRange; kpis: MarketingKpis; email: EmailSummary; webinars: WebinarSummary; empty: boolean };

/** Rule 75 KPIs with the email and webinar summaries (`reports.read`). */
export async function getMarketingDashboard(ctx: OpsReadCtx, input: RangeInput = {}): Promise<MarketingDashboard> {
  requireAny(ctx, "reports.read");
  const range = rangeOf(ctx, input);
  const kpis = await computeMarketingKpis(ctx.tx, range);
  const email = await computeEmailSummary(ctx.tx, { range });
  const webinars = await computeWebinarSummary(ctx.tx, { range });
  const c = kpis.current;
  const empty = c.leads === 0 && c.registrationRate.numerator === 0 && email.total.sent === 0 && webinars.total.registered === 0 && c.abandoned.abandoned === 0 && c.reactivationOrders === 0;
  return { range, kpis, email, webinars, empty };
}

/** Rules 72-73 (`reports.read`): per campaign revenue, spend, CPL, CAC, ROAS and LTV. */
export async function getAttributionReport(ctx: OpsReadCtx, input: RangeInput & { model?: AttributionModel } = {}): Promise<AttributionReport> {
  requireAny(ctx, "reports.read");
  return computeAttributionReport(ctx.tx, { range: rangeOf(ctx, input), model: input.model === "first_touch" ? "first_touch" : "linear" });
}

/** Rule 73a (`reports.read`): the funnel per campaign key (at most 50 keys) or of one key. */
export async function getCampaignFunnel(ctx: OpsReadCtx, input: RangeInput & { campaignKey?: string } = {}): Promise<CampaignFunnelRow[]> {
  requireAny(ctx, "reports.read");
  const rows = await computeCampaignFunnel(ctx.tx, { range: rangeOf(ctx, input), ...(input.campaignKey ? { campaignKey: input.campaignKey.slice(0, 400) } : {}) });
  return rows.slice(0, 50);
}

/** Rule 75's email performance per campaign (`reports.read`). */
export async function getEmailSummary(ctx: OpsReadCtx, input: RangeInput = {}): Promise<EmailSummary> {
  requireAny(ctx, "reports.read");
  return computeEmailSummary(ctx.tx, { range: rangeOf(ctx, input) });
}

/** The webinar performance summary (`reports.read`). */
export async function getWebinarSummary(ctx: OpsReadCtx, input: RangeInput = {}): Promise<WebinarSummary> {
  requireAny(ctx, "reports.read");
  return computeWebinarSummary(ctx.tx, { range: rangeOf(ctx, input) });
}

/** Rule 74 (`reports.read`): spend, impressions, clicks and platform leads per campaign and day, and the last pull per account. */
export async function getAdsReport(ctx: OpsReadCtx, input: RangeInput = {}): Promise<AdsReport> {
  requireAny(ctx, "reports.read");
  return computeAdsReport(ctx.tx, rangeOf(ctx, input));
}
