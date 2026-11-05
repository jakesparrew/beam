/**
 * Guest and package-sharing controls (credits spec rules 40 to 43, section 4; credits-P8, R2).
 *
 * - `updateGrantSharing`: staff set `sharing.mode` and `max_guest_uses_per_month` per grant
 *   (audit `credits.sharing_changed`). Leaving mode `named` revokes the grant's active shares, so
 *   active shares exist only on `named` grants and the cache stays exact.
 * - `addShare`: a named share for a person found or created by email (`crm.findOrCreatePersonByEmail`,
 *   no consent granted). The owner from the portal needs mode `named` and has at most 5 active
 *   shares per grant; staff are not limited and switch the grant to `named`. The grant row is
 *   locked `FOR UPDATE` before counting, so two parallel invitations cannot pass the limit.
 *   Events `credits.share_added` (owner and invitee), email `credits.share_invitation`, audit
 *   `credits.share_added`.
 * - `revokeShare`: stops future use; past entries and bookings stay (rule 42).
 * - `reviewSharing`: a decision on a `v_sharing_review` item, stored with the person set seen;
 *   `sharing_disabled` sets mode `none` on the grant (rule `many_guests`) or on every grant the
 *   guest used in the last 30 days (rule `guest_hopping`) in the same transaction.
 * - `listSharingReview`, `countSharingReviewItems`: the single abuse list (booking, ops).
 *
 * `sharing.allowed_person_ids` is a cache of the active shares, rebuilt in every transaction that
 * changes one (rule 29). Euro and membership grants are never shared (rules 2 and 31).
 */
import { z } from "zod";
import type { DbOrTx, Tx } from "@beam/db";
import { creditEntries, creditGrants, creditSharingReviews, packageShares, persons, vSharingReview } from "@beam/db/schema";
import type { CreditKind, GrantSharing } from "@beam/core/credits";
import type { Locale } from "@beam/core/i18n";
import { and, asc, ConflictError, desc, eq, inArray, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { lockGrant, type GrantRow } from "./ledger";

// crm and email are loaded on call: their import graphs reach booking, which imports credits' api
// (and the portal and admin pages read this file through `queries.ts`).
const crm = () => import("@/modules/crm/api");
const email = () => import("@/modules/email/api");

/** Rule 41: active named shares an owner may hold per grant from the portal (staff are not limited). */
export const MAX_PORTAL_SHARES = 5;

const uuid = z.string().uuid();
const sharingMode = z.enum(["none", "guests", "named"]);

export const UpdateGrantSharingInput = z.object({
  grantId: uuid,
  mode: sharingMode,
  maxGuestUsesPerMonth: z.coerce.number().int().min(0).max(31),
});
export type UpdateGrantSharingInput = z.infer<typeof UpdateGrantSharingInput>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const AddShareInput = z.object({
  grantId: uuid,
  email: z.string().trim().toLowerCase().email().max(254),
  firstName: z.string().trim().min(1).max(100),
  lastName: optionalText(100),
  maxUnits: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(1).max(100).optional()),
});
export type AddShareInput = z.input<typeof AddShareInput>;

export const RevokeShareInput = z.object({ shareId: uuid, reason: optionalText(500) });
export type RevokeShareInput = z.input<typeof RevokeShareInput>;

export const ReviewSharingInput = z
  .object({
    rule: z.enum(["many_guests", "guest_hopping"]),
    grantId: uuid.optional(),
    guestPersonId: uuid.optional(),
    decision: z.enum(["ok", "warned", "sharing_disabled"]),
    note: optionalText(1000),
  })
  .superRefine((v, c) => {
    if (v.rule === "many_guests" && (!v.grantId || v.guestPersonId)) c.addIssue({ code: "custom", path: ["grantId"], message: "required" });
    if (v.rule === "guest_hopping" && (!v.guestPersonId || v.grantId)) c.addIssue({ code: "custom", path: ["guestPersonId"], message: "required" });
  });
export type ReviewSharingInput = z.input<typeof ReviewSharingInput>;

/** Who adds or revokes a share: staff (any grant) or the grant owner through the portal. */
export type ShareBy = { kind: "staff"; userId: string } | { kind: "owner"; personId: string };

/** One row of `v_sharing_review` (rule 43). `personIds` are the guests (many_guests) or the owners (guest_hopping). */
export type SharingReviewRow = {
  rule: "many_guests" | "guest_hopping";
  grantId: string | null;
  guestPersonId: string | null;
  personIds: string[];
  distinctCount: number;
  lastAt: Date;
};

const grantRef = (grantId: string) => ({ type: "credit_grant", id: grantId });

/** "Anna D.": a person as another customer sees them (rule 38). */
function shortName(firstName: string | null, lastName: string | null): string {
  const first = (firstName ?? "").trim();
  const initial = (lastName ?? "").trim().charAt(0).toUpperCase();
  return [first, initial ? `${initial}.` : ""].filter(Boolean).join(" ");
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const i of r.error.issues) fields[String(i.path[0] ?? "input")] ??= i.message;
  throw new ValidationError("validation", fields);
}

function sharingSnapshot(s: GrantSharing) {
  return { mode: s.mode, max_guest_uses_per_month: s.max_guest_uses_per_month };
}

/** Rules 2 and 31: store credit and membership inclusions are never shared. */
function assertShareable(grant: GrantRow): void {
  if (grant.creditKind === "euro" || grant.source === "membership") throw new ConflictError("not_shareable");
}

/** Rebuilds `sharing.allowed_person_ids` from the active shares of a locked grant (rule 29). */
export async function rebuildSharingCache(tx: DbOrTx, ctx: Ctx, grantId: string): Promise<string[]> {
  const rows = await tx
    .select({ personId: packageShares.sharedWithPersonId })
    .from(packageShares)
    .where(and(eq(packageShares.grantId, grantId), eq(packageShares.status, "active")))
    .orderBy(asc(packageShares.sharedWithPersonId));
  const ids = [...new Set(rows.map((r) => r.personId))];
  await tx
    .update(creditGrants)
    .set({ sharing: sql`jsonb_set(${creditGrants.sharing}, '{allowed_person_ids}', ${JSON.stringify(ids)}::jsonb)`, updatedAt: ctx.now })
    .where(eq(creditGrants.id, grantId));
  return ids;
}

/** Revokes every active share of a locked grant (mode left `named`); returns the revoked rows. */
async function revokeAllShares(tx: DbOrTx, ctx: Ctx, grant: GrantRow, reason: string) {
  const revoked = await tx
    .update(packageShares)
    .set({ status: "revoked", revokedAt: ctx.now, revokedReason: reason, updatedAt: ctx.now })
    .where(and(eq(packageShares.grantId, grant.id), eq(packageShares.status, "active")))
    .returning();
  for (const s of revoked) await shareEvents(ctx, grant, s.id, s.sharedWithPersonId, "credits.share_revoked");
  return revoked;
}

async function shareEvents(
  ctx: Ctx,
  grant: GrantRow,
  shareId: string,
  sharedWithPersonId: string,
  kind: "credits.share_added" | "credits.share_revoked",
): Promise<void> {
  const data = { grant_id: grant.id, credit_kind: grant.creditKind, share_id: shareId, owner_person_id: grant.personId, shared_with_person_id: sharedWithPersonId };
  const suffix = kind === "credits.share_added" ? "share_added" : "share_revoked";
  await ctx.recordEvent({ kind, personId: grant.personId, ref: grantRef(grant.id), dedupeKey: `grant:${grant.id}:${suffix}:${shareId}`, data });
  await ctx.recordEvent({ kind, personId: sharedWithPersonId, ref: grantRef(grant.id), dedupeKey: `grant:${grant.id}:${suffix}:${shareId}:sharee`, data });
}

/**
 * Sets the sharing of a locked grant and audits `credits.sharing_changed` when it changed. Mode
 * `none` stores a guest limit of 0; leaving `named` revokes the active shares (`reason`).
 */
async function applySharing(
  tx: DbOrTx,
  ctx: Ctx,
  grant: GrantRow,
  next: { mode: GrantSharing["mode"]; maxGuestUsesPerMonth: number },
  reason: string,
): Promise<GrantSharing> {
  const old = grant.sharing;
  const max = next.mode === "none" ? 0 : next.maxGuestUsesPerMonth;
  if (old.mode === next.mode && old.max_guest_uses_per_month === max) return old;
  if (next.mode !== "named") await revokeAllShares(tx, ctx, grant, reason);
  const ids = next.mode === "named" ? old.allowed_person_ids : [];
  const sharing: GrantSharing = { mode: next.mode, max_guest_uses_per_month: max, allowed_person_ids: ids };
  await tx.update(creditGrants).set({ sharing, updatedAt: ctx.now }).where(eq(creditGrants.id, grant.id));
  if (next.mode !== "named") await rebuildSharingCache(tx, ctx, grant.id);
  await ctx.audit({
    action: "credits.sharing_changed",
    entityType: "credit_grant",
    entityId: grant.id,
    personId: grant.personId,
    oldValue: sharingSnapshot(old),
    newValue: sharingSnapshot(sharing),
  });
  grant.sharing = sharing;
  return sharing;
}

/** Rule 40 (staff, `credits.adjust`): mode and monthly guest limit of one grant. */
export async function updateGrantSharing(tx: DbOrTx, ctx: Ctx, raw: UpdateGrantSharingInput): Promise<{ sharing: GrantSharing }> {
  const input = parse(UpdateGrantSharingInput, raw);
  const grant = await lockGrant(tx, input.grantId);
  if (grant.status === "revoked") throw new ConflictError("grant_revoked");
  if (input.mode !== "none") assertShareable(grant);
  const sharing = await applySharing(tx, ctx, grant, input, "sharing_changed");
  return { sharing };
}

async function personLocale(tx: DbOrTx, personId: string): Promise<Locale> {
  const [p] = await tx.select({ locale: persons.locale }).from(persons).where(eq(persons.id, personId));
  return p?.locale ?? "nl-BE";
}

const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

/**
 * Rule 41: adds a named share. The owner (portal) needs mode `named` and fewer than 5 active
 * shares; staff switch the grant to `named` when needed. Sharing with the owner, a second active
 * share for the same person, or a grant that is not active are refused.
 */
export async function addShare(tx: Tx, ctx: Ctx, raw: AddShareInput, by: ShareBy): Promise<{ shareId: string; sharedWithPersonId: string; created: boolean }> {
  const input = parse(AddShareInput, raw);
  const grant = await lockGrant(tx, input.grantId).catch((error: unknown) => {
    throw error instanceof NotFoundError ? new NotFoundError("grant_not_found") : error;
  });
  if (by.kind === "owner" && grant.personId !== by.personId) throw new NotFoundError("grant_not_found");
  assertShareable(grant);
  if (grant.status !== "active") throw new ConflictError("grant_not_active");
  if (by.kind === "owner" && grant.sharing.mode !== "named") throw new ConflictError("not_shareable");

  const active = await tx
    .select({ id: packageShares.id, personId: packageShares.sharedWithPersonId })
    .from(packageShares)
    .where(and(eq(packageShares.grantId, grant.id), eq(packageShares.status, "active")));
  if (by.kind === "owner" && active.length >= MAX_PORTAL_SHARES) throw new ConflictError("share_limit");

  const ownerLocale = await personLocale(tx, grant.personId);
  const { personId: inviteeId } = await (await crm()).findOrCreatePersonByEmail(tx, ctx, {
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    locale: ownerLocale,
  });
  if (inviteeId === grant.personId) throw new ValidationError("share_with_owner", { email: "share_with_owner" });
  const existing = active.find((s) => s.personId === inviteeId);
  if (existing) throw new ConflictError("already_shared");

  const oldMode = grant.sharing.mode;
  if (by.kind === "staff" && oldMode !== "named") {
    await applySharing(tx, ctx, grant, { mode: "named", maxGuestUsesPerMonth: grant.sharing.max_guest_uses_per_month }, "sharing_changed");
  }
  const [share] = await tx
    .insert(packageShares)
    .values({
      grantId: grant.id,
      sharedWithPersonId: inviteeId,
      maxUnits: input.maxUnits ?? null,
      createdByUserId: by.kind === "staff" ? by.userId : null,
      createdByPersonId: by.kind === "owner" ? by.personId : null,
    })
    .returning({ id: packageShares.id });
  await rebuildSharingCache(tx, ctx, grant.id);
  await shareEvents(ctx, grant, share!.id, inviteeId, "credits.share_added");

  const [owner] = await tx.select({ firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(eq(persons.id, grant.personId));
  const locale = await personLocale(tx, inviteeId);
  await (await email()).sendTransactional(ctx, {
    template: "credits.share_invitation",
    personId: inviteeId,
    locale,
    data: {
      shareId: share!.id,
      ownerName: shortName(owner?.firstName ?? null, owner?.lastName ?? null) || "BEAM",
      creditKind: grant.creditKind,
      maxUnits: input.maxUnits ?? null,
      accountUrl: appUrl(`/${locale}/account/packages`),
    },
    key: `credits:share_invitation:${share!.id}:invite`,
  });
  await ctx.audit({
    action: "credits.share_added",
    entityType: "credit_grant",
    entityId: grant.id,
    personId: grant.personId,
    oldValue: { mode: oldMode, active_shares: active.length },
    newValue: { mode: "named", active_shares: active.length + 1, share_id: share!.id, max_units: input.maxUnits ?? null },
  });
  return { shareId: share!.id, sharedWithPersonId: inviteeId, created: true };
}

/** Rule 42: revokes one share (owner or staff); revoking a revoked share changes nothing. */
export async function revokeShare(tx: DbOrTx, ctx: Ctx, raw: RevokeShareInput, by: ShareBy): Promise<{ revoked: boolean }> {
  const input = parse(RevokeShareInput, raw);
  const [found] = await tx.select({ grantId: packageShares.grantId }).from(packageShares).where(eq(packageShares.id, input.shareId));
  if (!found) throw new NotFoundError("share_not_found");
  const grant = await lockGrant(tx, found.grantId);
  if (by.kind === "owner" && grant.personId !== by.personId) throw new NotFoundError("share_not_found");
  const [share] = await tx.select().from(packageShares).where(eq(packageShares.id, input.shareId)).for("update");
  if (!share || share.status !== "active") return { revoked: false };
  const reason = input.reason ?? (by.kind === "owner" ? "revoked_by_owner" : "revoked_by_staff");
  await tx
    .update(packageShares)
    .set({ status: "revoked", revokedAt: ctx.now, revokedReason: reason, updatedAt: ctx.now })
    .where(eq(packageShares.id, share.id));
  await rebuildSharingCache(tx, ctx, grant.id);
  await shareEvents(ctx, grant, share.id, share.sharedWithPersonId, "credits.share_revoked");
  await ctx.audit({
    action: "credits.share_revoked",
    entityType: "credit_grant",
    entityId: grant.id,
    personId: grant.personId,
    oldValue: { share_id: share.id, status: "active" },
    newValue: { share_id: share.id, status: "revoked" },
  });
  return { revoked: true };
}

// ---------------------------------------------------------------------------
// Review list (rule 43)
// ---------------------------------------------------------------------------

function toReviewRow(r: typeof vSharingReview.$inferSelect): SharingReviewRow {
  return {
    rule: r.rule,
    grantId: r.grantId,
    guestPersonId: r.guestPersonId,
    personIds: [...(r.personIds ?? [])].sort(),
    distinctCount: Number(r.distinctCount),
    lastAt: r.lastAt,
  };
}

/** The open review items, most recent use first. */
export async function listSharingReview(db: DbOrTx, opts: { limit: number }): Promise<SharingReviewRow[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit) || 1));
  const rows = await db.select().from(vSharingReview).orderBy(desc(vSharingReview.lastAt), asc(vSharingReview.rule)).limit(limit);
  return rows.map(toReviewRow);
}

export async function countSharingReviewItems(db: DbOrTx): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(vSharingReview);
  return Number(r?.n ?? 0);
}

/**
 * Rule 43: stores a decision with the person set seen now (the item stays hidden until a new
 * person appears); `sharing_disabled` sets mode `none` in the same transaction.
 */
export async function reviewSharing(tx: DbOrTx, ctx: Ctx, raw: ReviewSharingInput): Promise<{ reviewId: string; disabledGrantIds: string[] }> {
  if (ctx.actor.kind !== "staff") throw new ConflictError("staff_only");
  const input = parse(ReviewSharingInput, raw);
  const subject =
    input.rule === "many_guests" ? eq(vSharingReview.grantId, input.grantId!) : eq(vSharingReview.guestPersonId, input.guestPersonId!);
  const [item] = await tx.select().from(vSharingReview).where(and(sql`${vSharingReview.rule} = ${input.rule}`, subject));
  if (!item) throw new NotFoundError("review_item_not_found");
  const seen = toReviewRow(item).personIds;

  let grantIds: string[] = [];
  if (input.decision === "sharing_disabled") {
    if (input.rule === "many_guests") grantIds = [input.grantId!];
    else {
      const used = await tx
        .selectDistinct({ id: creditEntries.grantId })
        .from(creditEntries)
        .where(
          and(
            eq(creditEntries.kind, "consume"),
            eq(creditEntries.beneficiaryPersonId, input.guestPersonId!),
            sql`${creditEntries.personId} <> ${input.guestPersonId!}`,
            sql`${creditEntries.createdAt} > ${ctx.now.toISOString()}::timestamptz - interval '30 days'`,
          ),
        );
      grantIds = used.map((u) => u.id).sort();
    }
  }
  const disabled: string[] = [];
  for (const id of grantIds) {
    const grant = await lockGrant(tx, id);
    if (grant.sharing.mode === "none") continue;
    await applySharing(tx, ctx, grant, { mode: "none", maxGuestUsesPerMonth: 0 }, "sharing_disabled");
    disabled.push(id);
  }

  const [row] = await tx
    .insert(creditSharingReviews)
    .values({
      rule: input.rule,
      grantId: input.rule === "many_guests" ? input.grantId! : null,
      guestPersonId: input.rule === "guest_hopping" ? input.guestPersonId! : null,
      guestPersonIds: seen,
      decision: input.decision,
      note: input.note ?? null,
      reviewedByUserId: ctx.actor.userId,
    })
    .returning({ id: creditSharingReviews.id });
  await ctx.audit({
    action: "credits.sharing_reviewed",
    entityType: input.rule === "many_guests" ? "credit_grant" : "person",
    entityId: input.rule === "many_guests" ? input.grantId! : input.guestPersonId!,
    personId: input.rule === "guest_hopping" ? input.guestPersonId! : null,
    oldValue: null,
    newValue: { rule: input.rule, decision: input.decision, distinct_count: seen.length, disabled_grant_ids: disabled },
  });
  return { reviewId: row!.id, disabledGrantIds: disabled };
}

// ---------------------------------------------------------------------------
// Portal: the owner's shares
// ---------------------------------------------------------------------------

/** One share an owner gave, as the owner sees it (rule 38: first name and initial). */
export type MyShareRow = {
  shareId: string;
  grantId: string;
  creditKind: CreditKind;
  sharedWithName: string;
  maxUnits: number | null;
  /** Units the sharee used on the grant (net of returns). */
  usedUnits: number;
  status: "active" | "revoked";
  createdAt: Date;
  revokedAt: Date | null;
};

/** The shares `personId` gave on their own grants (all, or of one grant), active first, newest first. */
export async function getMySharesGiven(db: DbOrTx, personId: string, opts: { grantId?: string } = {}): Promise<MyShareRow[]> {
  const used = sql<number>`(select coalesce(-sum(e.quantity), 0)::int from credit_entries e
      where e.grant_id = ${packageShares.grantId} and e.kind in ('consume', 'release') and e.beneficiary_person_id = ${packageShares.sharedWithPersonId})`;
  const rows = await db
    .select({
      shareId: packageShares.id,
      grantId: packageShares.grantId,
      creditKind: creditGrants.creditKind,
      first: persons.firstName,
      last: persons.lastName,
      maxUnits: packageShares.maxUnits,
      usedUnits: used,
      status: packageShares.status,
      createdAt: packageShares.createdAt,
      revokedAt: packageShares.revokedAt,
    })
    .from(packageShares)
    .innerJoin(creditGrants, eq(creditGrants.id, packageShares.grantId))
    .innerJoin(persons, eq(persons.id, packageShares.sharedWithPersonId))
    .where(and(eq(creditGrants.personId, personId), opts.grantId ? eq(packageShares.grantId, opts.grantId) : undefined))
    .orderBy(asc(packageShares.status), desc(packageShares.createdAt), asc(packageShares.id));
  return rows.map(({ first, last, ...r }) => ({ ...r, usedUnits: Number(r.usedUnits), sharedWithName: shortName(first, last) }));
}

/** People names for the review list (staff see full names, rule 38). */
export async function personNames(db: DbOrTx, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: persons.id, name: sql<string>`btrim(coalesce(${persons.firstName}, '') || ' ' || coalesce(${persons.lastName}, ''))` })
    .from(persons)
    .where(inArray(persons.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}
