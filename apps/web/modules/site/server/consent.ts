/**
 * Cookie consent on the server (site rules 36-39, privacy section 9; site-P5). Every banner
 * choice appends one `cookie_consents` row; the visitor's `beam_consent` cookie holds only
 * `{k, v, a, m, t}`. The IP is never stored, only its HMAC-SHA256 with `AUTH_SECRET` (first 32
 * hex characters). The banner version is the published ordinal of the live cookie notice.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { cookieConsents, pages, vLegalVersions } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import {
  choicesFor,
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  encodeConsentCookie,
  type ConsentAction,
  type ConsentChoices,
} from "@beam/core/site";
import { and, eq } from "@/lib/ctx";

export type RecordCookieConsentInput = {
  /** The key of the visitor's existing cookie; a new one is created when absent. */
  consentKey?: string | null;
  action: ConsentAction;
  choices: ConsentChoices;
  bannerVersion: number;
  locale: Locale;
  /** Set when a customer session exists. */
  personId?: string | null;
  /** The request IP; stored only as an HMAC. */
  ip?: string | null;
  now?: Date;
};

/** HMAC-SHA256 of the IP with `AUTH_SECRET`, first 32 hex characters; null without an IP. */
export function hashIp(ip: string | null | undefined, secret: string = process.env.AUTH_SECRET ?? ""): string | null {
  const value = ip?.trim();
  if (!value) return null;
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);
}

/** Appends one `cookie_consents` row and returns the consent key (new or the visitor's own). */
export async function recordCookieConsent(db: DbOrTx, input: RecordCookieConsentInput): Promise<{ consentKey: string }> {
  const consentKey = (input.consentKey ?? randomUUID()).toLowerCase();
  const choices = choicesFor(input.action, input.choices);
  await db.insert(cookieConsents).values({
    consentKey,
    personId: input.personId ?? null,
    choices,
    bannerVersion: Math.max(0, Math.trunc(input.bannerVersion)),
    action: input.action,
    locale: input.locale,
    ipHash: hashIp(input.ip),
    ...(input.now ? { recordedAt: input.now } : {}),
  });
  return { consentKey };
}

/** The `Set-Cookie` value of `beam_consent` (readable by JS, so not HttpOnly). */
export function consentSetCookie(input: { consentKey: string; bannerVersion: number; choices: ConsentChoices; now: Date }): string {
  const value = encodeConsentCookie({
    k: input.consentKey,
    v: Math.max(0, Math.trunc(input.bannerVersion)),
    a: input.choices.analytics,
    m: input.choices.marketing,
    t: Math.floor(input.now.getTime() / 1000),
  });
  return `${CONSENT_COOKIE}=${value}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
}

export type CookieBannerState = {
  /** Ordinal of the live cookie notice (0 when none is published). */
  bannerVersion: number;
  /** Highest ordinal of a published cookie notice with `is_material_change`, or null. */
  latestMaterialOrdinal: number | null;
};

/** The banner version and the re-prompt threshold (rule 38). */
export async function getCookieBannerState(db: DbOrTx): Promise<CookieBannerState> {
  const rows = await db
    .select({ ordinal: vLegalVersions.ordinal, isMaterialChange: vLegalVersions.isMaterialChange, isCurrent: vLegalVersions.isCurrent, status: pages.status })
    .from(vLegalVersions)
    .innerJoin(pages, and(eq(pages.legalKey, vLegalVersions.legalKey), eq(pages.currentVersionId, vLegalVersions.versionId)))
    .where(eq(vLegalVersions.legalKey, "cookie_notice"));
  const all = await db
    .select({ ordinal: vLegalVersions.ordinal, isMaterialChange: vLegalVersions.isMaterialChange })
    .from(vLegalVersions)
    .where(eq(vLegalVersions.legalKey, "cookie_notice"));
  const live = rows.find((r) => r.isCurrent && r.status === "published");
  const material = all.filter((r) => r.isMaterialChange).map((r) => Number(r.ordinal));
  return { bannerVersion: live ? Number(live.ordinal) : 0, latestMaterialOrdinal: material.length > 0 ? Math.max(...material) : null };
}
