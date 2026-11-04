import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { persons, segmentMembers, segments } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { fullTableSource, readChunk } from "./entities";
import { bulkPersons, csvRows, drainExports, exportOf, partText, seedExport } from "./ops-p6.fixtures";

let h: DbHandle;
let userId: string;
beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db, { roleKey: "technical_admin" })).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const LOW_ID = "00000000-0000-4000-8000-000000000000";

async function exportedIds(exportId: string): Promise<string[]> {
  const exp = await exportOf(h.db, exportId);
  const out: string[] = [];
  for (const fileId of exp.partFileIds) {
    const [header, ...rows] = csvRows(await partText(h.db, fileId));
    const at = header!.indexOf("id");
    out.push(...rows.map((r) => r[at]!));
  }
  return out;
}

describe("export chunks page by key (review findings 2 and 4, rule 55)", () => {
  /** Runs chunk 0 (twice: the retry reuses the recorded part and its key), then `between`, then the rest. */
  async function exportAround(between: (firstPart: string[]) => Promise<void>) {
    const before = rowsOf<{ id: string }>(await h.db.execute(sql`select id::text as id from persons where processing_restricted_at is null order by id`)).map((r) => r.id);
    const id = await seedExport(h.db, { userId, entity: "persons" });
    await runJobTwice(h.db, "ops.export_chunk", { exportId: id, entity: "persons", offset: 0 });
    const afterFirst = await exportOf(h.db, id);
    expect(afterFirst.cursorData.parts).toHaveLength(1);
    expect(afterFirst.cursorData.parts[0]!.lastKey).toEqual([before[4_999]]);
    await between(before.slice(0, 5_000));
    await drainExports(h.db);
    const exp = await exportOf(h.db, id);
    expect(exp.status).toBe("done");
    const exported = await exportedIds(id);
    expect(new Set(exported).size).toBe(exported.length);
    expect(exported.length).toBe(exp.rowCount);
    return { before, exported: [...exported].sort(), parts: exp.cursorData.parts.map((p) => [p.name, p.rows]) };
  }

  it("a row inserted below the boundary between chunk 0 and chunk 1 does not repeat a row in part 2", async () => {
    await bulkPersons(h.db, "keyset", 5_100);
    const { before, exported, parts } = await exportAround(async () => {
      await makePerson(h.db, { id: LOW_ID, email: "keyset-low@example.com" });
    });
    expect(parts).toEqual([
      ["persons-1.csv", 5000],
      ["persons-2.csv", before.length - 5000],
    ]);
    expect(exported).toEqual(before);
    await h.db.delete(persons).where(eq(persons.id, LOW_ID));
  }, 240_000);

  it("a row of part 1 deleted between chunk 0 and chunk 1 does not drop a row from part 2", async () => {
    const { before, exported, parts } = await exportAround(async (firstPart) => {
      const [victim] = rowsOf<{ id: string }>(
        await h.db.execute(sql`select id::text as id from persons where email like 'keyset-%' and id = any(${`{${firstPart.join(",")}}`}::uuid[]) order by id limit 1`),
      );
      await h.db.delete(persons).where(eq(persons.id, victim!.id));
    });
    expect(parts).toEqual([
      ["persons-1.csv", 5000],
      ["persons-2.csv", before.length - 5000],
    ]);
    expect(exported).toEqual(before);
  }, 240_000);

  it("a composite primary key in the full export pages by row comparison, typed per column", async () => {
    const [seg] = await h.db.insert(segments).values({ name: "Keyset", kind: "static" }).returning({ id: segments.id });
    const people = await Promise.all(Array.from({ length: 5 }, (_, i) => makePerson(h.db, { email: `keyset-seg-${i}@example.com` })));
    await h.db.insert(segmentMembers).values(people.map((p) => ({ segmentId: seg!.id, personId: p.id, source: "manual" as const })));
    const source = await fullTableSource(h.db, "segment_members");
    expect(source.key).toEqual({ columns: ["segment_id", "person_id"], types: ["uuid", "uuid"] });

    const seen: string[] = [];
    let after: string[] | null = null;
    for (let i = 0; i < 10; i++) {
      const chunk: Awaited<ReturnType<typeof readChunk>> = await readChunk(h.db, source, after, 2);
      if (!chunk.rows.length) break;
      seen.push(...chunk.rows.map((r) => String(r[source.columns.indexOf("person_id")])));
      after = chunk.lastKey;
    }
    expect(seen).toHaveLength(5);
    expect([...seen].sort()).toEqual(people.map((p) => p.id).sort());
  });

  it("a table whose key holds an excluded column keeps it out of the cursor and pages by OFFSET", async () => {
    const source = await fullTableSource(h.db, "auth_verification_tokens");
    expect(source.excluded).toContain("token");
    expect(source.key).toBeNull();
  });
});
