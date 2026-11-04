/** forms-P3: `publishVersion` and the server checks of rule P7 (DPIA gate, CTA targets, outcome tags; cross-module D38). */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { forms, formVersions, products, tags } from "@beam/db/schema";
import { createTestDb, makeProduct, makeUser } from "@beam/db/testing";
import { eq } from "@/lib/ctx";
import { makeCtx, resetRuntime, staffActor } from "@/lib/testing";
import { assessment, lead, setupEnv, T, uniqueSlug } from "../forms-p3.fixtures";

const dpia = vi.hoisted(() => ({ approved: false, calls: [] as string[] }));
vi.mock("@/modules/ops/api", () => ({
  isDpiaApproved: vi.fn((_db: unknown, key: string) => {
    dpia.calls.push(key);
    return Promise.resolve(dpia.approved);
  }),
}));

const { insertDraftVersion, publishVersion, PublishRefusedError } = await import("./versions");

let h: DbHandle;
let userId: string;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
  await h.db.insert(tags).values([{ key: "interest:sleep", name: T("Sleep") }, { key: "interest:breathwork", name: T("Breathwork") }]);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  dpia.approved = false;
  dpia.calls = [];
});

const publisher = () => makeCtx(h.db, staffActor({ userId, permissions: ["forms.publish", "forms.write"] }));

async function draftOf(content: ReturnType<typeof assessment>) {
  const [f] = await h.db.insert(forms).values({ slug: uniqueSlug("p3v"), kind: content.kind, name: T("Form") }).returning();
  const d = await insertDraftVersion(h.db, { formId: f!.id, ...content, createdByUserId: null });
  return { formId: f!.id, versionId: d.versionId };
}

const publish = (d: { formId: string; versionId: string }, ctx = publisher()) => publishVersion(ctx.tx, ctx, { ...d, changeNote: "first" });

describe("P7: DPIA gate for versions with sensitive fields", () => {
  it("fails with dpia_not_approved while ops says no, publishes once approved", async () => {
    const d = await draftOf(assessment());
    const err = await publish(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishRefusedError);
    expect((err as InstanceType<typeof PublishRefusedError>).issues.map((i) => i.code)).toContain("dpia_not_approved");
    expect(dpia.calls).toEqual(["sensitive_assessment_processing"]);
    dpia.approved = true;
    expect(await publish(d)).toEqual({ version: 1 });
    const [f] = await h.db.select().from(forms).where(eq(forms.id, d.formId));
    expect(f).toMatchObject({ status: "published", currentVersionId: d.versionId });
    const [v] = await h.db.select().from(formVersions).where(eq(formVersions.id, d.versionId));
    expect(v!.changeNote).toBe("first");
    expect(v!.publishedByUserId).not.toBeNull();
  });

  it("a version without sensitive fields never calls isDpiaApproved", async () => {
    const d = await draftOf(lead());
    expect(await publish(d)).toEqual({ version: 1 });
    expect(dpia.calls).toEqual([]);
  });
});

describe("P7: other server checks and the permission", () => {
  it("needs forms.publish", async () => {
    const d = await draftOf(lead());
    const ctx = makeCtx(h.db, staffActor({ permissions: ["forms.write"] }));
    await expect(publish(d, ctx)).rejects.toThrow(/forms\.publish/);
  });

  it("an inactive product CTA and an unknown outcome tag block the publish", async () => {
    dpia.approved = true;
    const a = assessment();
    const product = await makeProduct(h.db);
    await h.db.update(products).set({ isActive: false }).where(eq(products.id, product.id));
    a.definition.endings[0]!.ctas.push({ key: "shop", label: T("Shop"), kind: "product", productId: product.id });
    a.scoring.outcomes[0]!.tagKeys.push("missing:p3");
    const d = await draftOf(a);
    const err = (await publish(d).catch((e: unknown) => e)) as InstanceType<typeof PublishRefusedError>;
    expect(err).toBeInstanceOf(PublishRefusedError);
    const codes = err.issues.filter((i) => i.level === "error").map((i) => `${i.code}:${i.path}`);
    expect(codes).toContain("cta_target_missing:endings.result_reset.ctas.shop");
    expect(codes.some((c) => c.startsWith("unknown_outcome:scoring.outcomes.reset_now.tagKeys"))).toBe(true);

    await h.db.update(products).set({ isActive: true }).where(eq(products.id, product.id));
    await h.db.insert(tags).values({ key: "missing:p3", name: T("Now exists") });
    expect(await publish(d)).toEqual({ version: 1 });
  });
});
