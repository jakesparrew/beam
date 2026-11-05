"use server";
/**
 * site server actions, Claude proposals (site spec section 4, rules 41, 46, 55-56; site-P4):
 * requestProposal, cancelProposalRequest, rejectProposal, copyProposalToDraft, and the Claude
 * panel's state read (`getClaudePanelState`, polled every 2 s). Asking Claude needs `site.edit`
 * and `ai.use`; one active request per page (a second is `conflict`). A proposal is published
 * through `publishVersion` (`site.publish`), rejected with a reason, or copied into the draft; it is
 * never edited in place. R4 (site-P10): `kind: "translate"` ("Translate missing locales") asks for the
 * locales the base lacks; its instruction is optional.
 */
import { z } from "zod";
import { pageEditRequests, pageVersions } from "@beam/db/schema";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { actorHasPermission, and, ConflictError, desc, eq, inArray, NotFoundError, type Ctx } from "@/lib/ctx";
import { proposeJobKey } from "../jobs/propose";
import { getEditRequest, type EditRequestView } from "../queries/proposals";
import { contentDigest, findDraft, getVersionOrThrow, insertDraft, lockPage, updateDraftContent, versionContent, type VersionRow } from "../server/versions";

const uuid = z.string().uuid();
const userId = (ctx: Ctx): string | null => (ctx.actor.kind === "staff" ? ctx.actor.userId : null);

/** The base a request works from: the draft, else the live version, else the newest version. */
async function proposalBase(ctx: Ctx, pageId: string, currentVersionId: string | null): Promise<VersionRow | null> {
  const draft = await findDraft(ctx.tx, pageId);
  if (draft) return draft;
  if (currentVersionId) return getVersionOrThrow(ctx.tx, currentVersionId);
  const [newest] = await ctx.tx.select().from(pageVersions).where(eq(pageVersions.pageId, pageId)).orderBy(desc(pageVersions.version)).limit(1);
  return newest ?? null;
}

// ---------------------------------------------------------------------------------------------
// requestProposal (rule 41), cancelProposalRequest (rule 56)
// ---------------------------------------------------------------------------------------------

const RequestProposalInput = z
  .object({
    pageId: uuid,
    /** Optional only for `translate`, which then stores `TRANSLATE_INSTRUCTION`. */
    instruction: z.string().trim().min(3).max(4000).optional(),
    locales: z.array(z.enum(LOCALES)).min(1).max(3).optional(),
    kind: z.enum(["edit", "new_page", "translate"]),
  })
  .refine((v) => v.kind === "translate" || v.instruction !== undefined, { path: ["instruction"], message: "required" });

/** The stored instruction of a "Translate missing locales" request without staff wording (R4). */
const TRANSLATE_INSTRUCTION = (locales: readonly Locale[]) => `Translate the page into ${locales.join(", ")}, keeping its blocks and structure.`;

/**
 * The target locales of a request. `translate` (R4, site-P10): the locales the base lacks (limited
 * to `requested` when given); a page without content, or with every locale, has nothing to
 * translate (`conflict`). Other kinds: `requested`, else the base's locales, else nl-BE.
 */
function targetLocales(kind: "edit" | "new_page" | "translate", base: VersionRow | null, requested: readonly Locale[] | undefined): Locale[] {
  const fromBase = (base?.locales ?? []).filter((l): l is Locale => (LOCALES as readonly string[]).includes(l));
  if (kind !== "translate") return LOCALES.filter((l) => (requested ?? (fromBase.length ? fromBase : ["nl-BE"])).includes(l));
  if (!base || !fromBase.length) throw new ConflictError("translate_no_content");
  const missing = LOCALES.filter((l) => !fromBase.includes(l) && (!requested || requested.includes(l)));
  if (!missing.length) throw new ConflictError("translate_nothing_missing");
  return missing;
}

export const requestProposal = action(
  { name: "site.proposal.request", audience: "staff", permission: "site.edit", input: RequestProposalInput },
  async (ctx, input): Promise<{ editRequestId: string }> => {
    ctx.require("ai.use");
    const tx = ctx.tx;
    const page = await lockPage(tx, input.pageId);
    if (page.status === "archived") throw new ConflictError("page_archived");
    const [active] = await tx
      .select({ id: pageEditRequests.id })
      .from(pageEditRequests)
      .where(and(eq(pageEditRequests.pageId, page.id), inArray(pageEditRequests.status, ["pending", "running"])));
    if (active) throw new ConflictError("request_active");
    const base = await proposalBase(ctx, page.id, page.currentVersionId);
    const locales = targetLocales(input.kind, base, input.locales);
    const instruction = input.instruction ?? TRANSLATE_INSTRUCTION(locales);
    const requester = userId(ctx);
    if (!requester) throw new ConflictError("staff_required");
    const [row] = await tx
      .insert(pageEditRequests)
      .values({
        pageId: page.id,
        kind: input.kind,
        instruction,
        locales,
        baseVersionId: base?.id ?? null,
        baseUpdatedAt: base?.updatedAt ?? null,
        requestedByUserId: requester,
      })
      .onConflictDoNothing()
      .returning({ id: pageEditRequests.id });
    if (!row) throw new ConflictError("request_active");
    await ctx.enqueue({ kind: "site.propose_page", payload: { editRequestId: row.id }, key: proposeJobKey(row.id) });
    await ctx.audit({
      action: "site.proposal.request",
      entityType: "page",
      entityId: page.id,
      newValue: { editRequestId: row.id, kind: input.kind, locales, baseVersionId: base?.id ?? null, instructionLength: instruction.length },
    });
    return { editRequestId: row.id };
  },
);

export const cancelProposalRequest = action(
  { name: "site.proposal.cancel", audience: "staff", permission: "site.edit", input: z.object({ editRequestId: uuid }) },
  async (ctx, input): Promise<{ ok: true }> => {
    const tx = ctx.tx;
    const [first] = await tx.select({ pageId: pageEditRequests.pageId }).from(pageEditRequests).where(eq(pageEditRequests.id, input.editRequestId));
    if (!first) throw new NotFoundError("request_not_found");
    await lockPage(tx, first.pageId);
    const [req] = await tx.select().from(pageEditRequests).where(eq(pageEditRequests.id, input.editRequestId)).for("update");
    if (req!.status !== "pending") throw new ConflictError(`request_${req!.status}`);
    await tx.update(pageEditRequests).set({ status: "cancelled", finishedAt: ctx.now, updatedAt: ctx.now }).where(eq(pageEditRequests.id, req!.id));
    await ctx.audit({ action: "site.proposal.cancel", entityType: "page", entityId: req!.pageId, oldValue: { status: "pending" }, newValue: { editRequestId: req!.id, status: "cancelled" } });
    return { ok: true };
  },
);

// ---------------------------------------------------------------------------------------------
// rejectProposal, copyProposalToDraft (rules 46, 55)
// ---------------------------------------------------------------------------------------------

/** Locks the page of a version and returns the version, which must still be `proposed`. */
async function lockProposal(ctx: Ctx, versionId: string): Promise<VersionRow> {
  const first = await getVersionOrThrow(ctx.tx, versionId);
  await lockPage(ctx.tx, first.pageId);
  const version = await getVersionOrThrow(ctx.tx, versionId);
  if (version.state !== "proposed" || version.publishedAt) throw new ConflictError(`version_${version.state}`);
  return version;
}

export const rejectProposal = action(
  { name: "site.proposal.reject", audience: "staff", permission: "site.edit", input: z.object({ versionId: uuid, reason: z.string().trim().min(1).max(500) }) },
  async (ctx, input): Promise<{ ok: true }> => {
    const version = await lockProposal(ctx, input.versionId);
    await ctx.tx
      .update(pageVersions)
      .set({ state: "rejected", rejectedAt: ctx.now, rejectedByUserId: userId(ctx), rejectReason: input.reason, scheduledPublishAt: null, updatedAt: ctx.now })
      .where(and(eq(pageVersions.id, version.id), eq(pageVersions.state, "proposed")));
    await ctx.audit({
      action: "site.proposal.reject",
      entityType: "page",
      entityId: version.pageId,
      oldValue: { versionId: version.id, state: "proposed" },
      newValue: { versionId: version.id, state: "rejected", reason: input.reason, editRequestId: version.editRequestId },
    });
    return { ok: true };
  },
);

export const copyProposalToDraft = action(
  { name: "site.proposal.copy_to_draft", audience: "staff", permission: "site.edit", input: z.object({ versionId: uuid, replaceExisting: z.boolean() }) },
  async (ctx, input): Promise<{ versionId: string }> => {
    const tx = ctx.tx;
    const proposal = await lockProposal(ctx, input.versionId);
    const page = await lockPage(tx, proposal.pageId);
    if (page.status === "archived") throw new ConflictError("page_archived");
    const content = { ...versionContent(proposal), changeSummary: proposal.changeSummary ?? null };
    const existing = await findDraft(tx, page.id);
    let draftId: string;
    let replaced: { versionId: string; sha256: string } | null = null;
    if (existing) {
      if (!input.replaceExisting) throw new ConflictError("draft_exists");
      // The draft row is overwritten in place: a proposal may be based on it (its FK stays valid).
      replaced = { versionId: existing.id, sha256: contentDigest({ ...versionContent(existing), changeSummary: existing.changeSummary }) };
      const saved = await updateDraftContent(tx, existing, content);
      const basedOn = proposal.basedOnVersionId && proposal.basedOnVersionId !== existing.id ? proposal.basedOnVersionId : existing.basedOnVersionId;
      await tx.update(pageVersions).set({ basedOnVersionId: basedOn, scheduledPublishAt: null }).where(and(eq(pageVersions.id, saved.id), eq(pageVersions.state, "draft")));
      draftId = saved.id;
    } else {
      const draft = await insertDraft(tx, { pageId: page.id, content, basedOnVersionId: proposal.basedOnVersionId ?? page.currentVersionId, userId: userId(ctx) });
      draftId = draft.id;
    }
    await tx.update(pageVersions).set({ state: "superseded", scheduledPublishAt: null, updatedAt: ctx.now }).where(and(eq(pageVersions.id, proposal.id), eq(pageVersions.state, "proposed")));
    await ctx.audit({
      action: "site.proposal.copy_to_draft",
      entityType: "page",
      entityId: page.id,
      oldValue: replaced,
      newValue: { proposalVersionId: proposal.id, draftVersionId: draftId, sha256: contentDigest(content), editRequestId: proposal.editRequestId },
    });
    return { versionId: draftId };
  },
);

// ---------------------------------------------------------------------------------------------
// The Claude panel's state (read; polled every 2 s)
// ---------------------------------------------------------------------------------------------

export type ClaudePanelState = { allowed: false } | { allowed: true; request: EditRequestView | null };

/**
 * Whether the panel shows (`ai.use`) and the page's latest request (or the one asked for). A read:
 * it writes nothing and is not audited.
 */
export const getClaudePanelState = action(
  { name: "site.proposal.status", audience: "staff", permission: "site.edit", input: z.object({ pageId: uuid, editRequestId: uuid.optional() }), audit: false },
  async (ctx, input): Promise<ClaudePanelState> => {
    if (!actorHasPermission(ctx.actor, "ai.use")) return { allowed: false };
    let id = input.editRequestId;
    if (!id) {
      const [latest] = await ctx.tx.select({ id: pageEditRequests.id }).from(pageEditRequests).where(eq(pageEditRequests.pageId, input.pageId)).orderBy(desc(pageEditRequests.createdAt)).limit(1);
      id = latest?.id;
    }
    const request = id ? await getEditRequest(id, ctx.tx) : null;
    return { allowed: true, request: request && request.pageId === input.pageId ? request : null };
  },
);
