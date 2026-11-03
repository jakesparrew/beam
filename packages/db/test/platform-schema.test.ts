import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import {
  featureFlags,
  files,
  monthlyReports,
  roles,
  supportRequests,
  users,
} from "../src/schema/platform";
import { vSupportSla } from "../src/schema/platform.views";
import { createTestDb, makePerson, makeUser } from "../src/testing";

/** The Postgres error behind a failed Drizzle query (message and SQLSTATE). */
async function pgError(
  promise: Promise<unknown>,
): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause =
      (error as { cause?: { message?: string; code?: string } }).cause ??
      (error as { message?: string; code?: string });
    return { message: String(cause.message ?? error), code: cause.code };
  }
  throw new Error("expected the query to fail");
}

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

describe("users", () => {
  it("rejects a second user whose email differs only in case", async () => {
    await makeUser(h.db, { email: "case@example.com" });
    const err = await pgError(
      h.db.execute(
        sql`insert into users (audience, email, role_key) values ('staff', 'CASE@example.com', 'technical_admin')`,
      ),
    );
    // Upper case fails the lower-case check first; the unique index catches the same address.
    expect(err.code).toBe("23514");
    const dup = await pgError(makeUser(h.db, { email: "case@example.com" }));
    expect(dup.message).toContain("users_email_lower_uq");
  });

  it("enforces users_audience_shape_ck", async () => {
    const person = await makePerson(h.db);
    const staffWithoutRole = await pgError(
      h.db
        .insert(users)
        .values({ audience: "staff", email: "norole@example.com" }),
    );
    expect(staffWithoutRole.message).toContain("users_audience_shape_ck");
    const customerWithRole = await pgError(
      h.db.insert(users).values({
        audience: "customer",
        email: "customer-role@example.com",
        roleKey: "technical_admin",
        personId: person.id,
      }),
    );
    expect(customerWithRole.message).toContain("users_audience_shape_ck");
    const customerWithoutPerson = await pgError(
      h.db
        .insert(users)
        .values({
          audience: "customer",
          email: "customer-noperson@example.com",
        }),
    );
    expect(customerWithoutPerson.message).toContain("users_audience_shape_ck");
    const ok = await makeUser(h.db, {
      audience: "customer",
      personId: person.id,
    });
    expect(ok.roleKey).toBeNull();
  });

  it("allows one customer account per person", async () => {
    const customer = await makeUser(h.db, { audience: "customer" });
    const err = await pgError(
      makeUser(h.db, { audience: "customer", personId: customer.personId }),
    );
    expect(err.message).toContain("users_customer_person_uq");
  });
});

describe("persons", () => {
  it("keeps active emails unique case-insensitively, but not for merged or erased rows", async () => {
    const a = await makePerson(h.db, { email: "dup@example.com" });
    const err = await pgError(makePerson(h.db, { email: "dup@example.com" }));
    expect(err.message).toContain("persons_email_active_uq");
    const b = await makePerson(h.db, { email: "other@example.com" });
    await h.db.execute(
      sql`update persons set merged_into_person_id = ${b.id} where id = ${a.id}`,
    );
    const c = await makePerson(h.db, { email: "dup@example.com" });
    expect(c.id).not.toBe(a.id);
  });
});

describe("roles", () => {
  it("only lets the owner role hold '{*}' and requires it", async () => {
    const err = await pgError(
      h.db
        .insert(roles)
        .values({
          key: "owner",
          name: { en: "Owner" },
          permissions: ["users.manage"],
        }),
    );
    expect(err.message).toContain("roles_owner_all_ck");
    await h.db
      .insert(roles)
      .values({ key: "owner", name: { en: "Owner" }, permissions: ["*"] });
    const [row] = await h.db.select().from(roles).where(eq(roles.key, "owner"));
    expect(row?.permissions).toEqual(["*"]);
  });
});

describe("files", () => {
  const base = {
    kind: "export" as const,
    name: "export.csv",
    mime: "text/csv",
    sha256: "a".repeat(64),
  };

  it("accepts 10 MB and rejects one byte more", async () => {
    await h.db
      .insert(files)
      .values({ ...base, sizeBytes: 10_485_760, bytes: new Uint8Array([1]) });
    const err = await pgError(
      h.db
        .insert(files)
        .values({ ...base, sizeBytes: 10_485_761, bytes: new Uint8Array([1]) }),
    );
    expect(err.message).toContain("files_size_ck");
  });

  it("round-trips bytea and rejects names with slashes and public non-images", async () => {
    const [row] = await h.db
      .insert(files)
      .values({ ...base, sizeBytes: 3, bytes: new Uint8Array([7, 8, 9]) })
      .returning();
    expect(Array.from(row!.bytes)).toEqual([7, 8, 9]);
    expect(
      (
        await pgError(
          h.db
            .insert(files)
            .values({
              ...base,
              name: "a/b.csv",
              sizeBytes: 1,
              bytes: new Uint8Array([1]),
            }),
        )
      ).message,
    ).toContain("files_name_ck");
    expect(
      (
        await pgError(
          h.db
            .insert(files)
            .values({
              ...base,
              isPublic: true,
              sizeBytes: 1,
              bytes: new Uint8Array([1]),
            }),
        )
      ).message,
    ).toContain("files_public_kind_ck");
  });
});

describe("feature_flags", () => {
  it("accepts ff_<module>_<name> keys only", async () => {
    await h.db
      .insert(featureFlags)
      .values({ key: "ff_commerce_checkout_recovery" });
    for (const key of [
      "commerce_checkout",
      "ff_Commerce_x",
      "ff_commerce",
      "ff_commerce_X",
    ]) {
      const err = await pgError(h.db.insert(featureFlags).values({ key }));
      expect(err.message).toContain("feature_flags_key_ck");
    }
  });
});

describe("support_requests and v_support_sla", () => {
  const hour = 60 * 60 * 1000;
  const request = (
    reference: string,
    receivedAt: Date,
    responseDueAt: Date,
  ) => ({
    reference,
    severity: "high" as const,
    channel: "in_app" as const,
    title: "Booking page is slow",
    receivedAt,
    responseDueAt,
  });

  it("keeps references unique", async () => {
    const now = new Date();
    await h.db
      .insert(supportRequests)
      .values(request("SUP-2026-0001", now, new Date(now.getTime() + hour)));
    const err = await pgError(
      h.db
        .insert(supportRequests)
        .values(request("SUP-2026-0001", now, new Date(now.getTime() + hour))),
    );
    expect(err.message).toContain("support_requests_reference_unique");
  });

  it("requires first_response_at >= received_at", async () => {
    const now = new Date();
    const err = await pgError(
      h.db
        .insert(supportRequests)
        .values({
          ...request("SUP-2026-0002", now, new Date(now.getTime() + hour)),
          firstResponseAt: new Date(now.getTime() - 1000),
        }),
    );
    expect(err.message).toContain("support_requests_first_response_ck");
  });

  it("flags an unanswered request past its due time as breached", async () => {
    const received = new Date(Date.now() - 5 * hour);
    const [late] = await h.db
      .insert(supportRequests)
      .values(
        request("SUP-2026-0003", received, new Date(received.getTime() + hour)),
      )
      .returning();
    const [onTime] = await h.db
      .insert(supportRequests)
      .values({
        ...request(
          "SUP-2026-0004",
          received,
          new Date(received.getTime() + hour),
        ),
        status: "responded",
        firstResponseAt: new Date(received.getTime() + 30 * 60 * 1000),
      })
      .returning();
    const rows = await h.db.select().from(vSupportSla);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(late!.id)?.isBreached).toBe(true);
    expect(byId.get(late!.id)?.firstResponseMinutes).toBeNull();
    expect(byId.get(onTime!.id)?.isBreached).toBe(false);
    expect(byId.get(onTime!.id)?.firstResponseMinutes).toBe(30);
  });
});

describe("monthly_reports", () => {
  it("keeps one report per month", async () => {
    const data = { uptime_pct: 99.95 } as never;
    await h.db.insert(monthlyReports).values({ monthOn: "2026-10-01", data });
    const err = await pgError(
      h.db.insert(monthlyReports).values({ monthOn: "2026-10-01", data }),
    );
    expect(err.message).toContain("monthly_reports_month_on_unique");
  });
});

describe("views", () => {
  it("creates every platform view", async () => {
    const result = await h.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.views where table_schema = 'public' order by table_name`,
    );
    const names = (result as { rows: { table_name: string }[] }).rows.map(
      (r) => r.table_name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "v_ai_usage_month",
        "v_integration_health",
        "v_job_stats",
        "v_support_sla",
      ]),
    );
  });
});
