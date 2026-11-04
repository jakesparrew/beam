/**
 * finance-P7 accountant CSV exports (finance spec rule 42, sections 4.2 to 4.5, edge case 26):
 * each V1 kind for a seeded month (October 2026: a paid two-rate invoice, an open bank-transfer
 * invoice and a paid partial credit note; one document in September and one in November stay out),
 * row counts, sums equal to `v_finance_vat_summary`, negative credit notes; the 366-day limit; a
 * double run of `finance.build_export` storing one file; audit rows for the request and the
 * download; the download refused without `reports.finance`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { makePerson } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { files, financeExports, vFinanceVatSummary } from "@beam/db/schema";
import { and, eq, setAppDb } from "@/lib/ctx";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { issueCreditNote, issueInvoice, markCreditNoteSettled } from "../api";
import { openInvoice, paidB2c, paidCompany } from "../finance-p4.helpers";
import { auditRows, signInStaff } from "../finance-p5.helpers";
import { asTx, ctxAt, payment, refund, setupDb } from "./__tests__/fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.44" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("../actions");
const { listFinanceExports } = await import("../queries");
const ex = await import("./exports");
const route = await import("@/app/(admin)/admin/finance/exports/[id]/route");

const OCT = { from: "2026-10-01", to: "2026-10-31" };
const at = (iso: string) => new Date(iso);

let h: DbHandle;
let seeded: { a: { number: string; orderId: string; paymentId: string; providerPaymentId: string }; b: { number: string }; cn: { number: string }; refundProviderId: string };

beforeAll(async () => {
  h = await setupDb();
  setAppDb(h.db);
  const db = h.db;
  // Outside the period, issued first because document dates follow the numbering: 30 September
  // in Brussels (20:00 UTC; 22:30 UTC would already be 1 October there).
  await paidB2c(db, undefined, at("2026-09-30T20:00:00Z"));
  // A: paid on 5 October, one line at 21 % (121.00) and one at 6 % (53.00).
  const person = await makePerson(db);
  const { order, lines } = await makePaidOrder(db, {
    personId: person.id,
    order: { paidAt: at("2026-10-05T09:00:00Z") },
    lines: [{ unitAmountCents: 12_100 }, { unitAmountCents: 5_300, vatRatePct: "6.00", vatCents: 300 }],
  });
  const p = await payment(db, order.id, { amountCents: order.totalCents, paidAt: at("2026-10-05T09:00:00Z") });
  const a = await issueInvoice(asTx(db), ctxAt(db, at("2026-10-05T09:00:00Z")), { orderId: order.id, paymentId: p.id });
  if (a.status !== "issued") throw new Error("A not issued");
  // B: open bank-transfer invoice of 12 October.
  const b = await openInvoice(db, { now: at("2026-10-12T10:00:00Z") });
  // CN: the 6 % line refunded on 20 October, money returned on 21 October.
  const r = await refund(db, p, 5_300, { providerRefundId: "re_test_0001" });
  const cn = await issueCreditNote(asTx(db), ctxAt(db, at("2026-10-20T10:00:00Z")), { invoiceId: a.invoiceId, refundId: r.id, reason: "Refund", lines: [{ orderLineId: lines[1]!.id, quantity: 1 }] });
  await markCreditNoteSettled(asTx(db), ctxAt(db, at("2026-10-21T10:00:00Z")), { refundId: r.id, settledAt: at("2026-10-21T10:00:00Z") });
  // Outside the period: a company invoice of 4 November.
  await paidCompany(db);
  seeded = { a: { number: a.number, orderId: order.id, paymentId: p.id, providerPaymentId: p.providerPaymentId! }, b: { number: b.number }, cn: { number: cn.number }, refundProviderId: "re_test_0001" };
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await signInStaff(jar, h.db, "finance");
});

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Minimal RFC 4180 reader for `;` files (quotes, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") row.push(cell), (cell = "");
    else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      (row = []), (cell = ""), i++;
    } else cell += c;
  }
  return rows;
}

const ok = <T>(r: { ok: boolean; data?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`action failed: ${JSON.stringify(r.error)}`);
  return r.data as T;
};

/** Requests an export through the action, runs its job twice, returns the parsed file. */
async function exportOf(kind: "invoices" | "invoice_lines" | "vat_summary" | "payments", period = OCT) {
  const { exportId } = ok(await actions.requestFinanceExport({ kind, ...period }));
  const { first, second } = await runJobTwice(h.db, "finance.build_export", { exportId });
  const [row] = await h.db.select().from(financeExports).where(eq(financeExports.id, exportId));
  const [file] = await h.db.select().from(files).where(eq(files.id, row!.fileId!));
  const text = decoder.decode(file!.bytes);
  const [header, ...body] = parseCsv(text.replace(/^\uFEFF/, ""));
  const records = body.map((cells) => Object.fromEntries(header!.map((k, i) => [k, cells[i]!])));
  return { exportId, row: row!, file: file!, text, header: header!, records, first, second };
}

const euros = (s: string | undefined) => Math.round(Number(s) * 100);

async function octoberSummary() {
  const rows = await h.db.select().from(vFinanceVatSummary).where(eq(vFinanceVatSummary.month, "2026-10-01"));
  return rows.map((r) => ({ kind: r.kind, rate: Number(r.vatRatePct), net: Number(r.netCents), vat: Number(r.vatCents), gross: Number(r.grossCents) }));
}

describe("invoices", () => {
  it("one row per document issued in the period, credit notes negative with the original's number", async () => {
    const out = await exportOf("invoices");
    expect(out.row).toMatchObject({ status: "done", rowCount: 3, error: null });
    expect(out.text.charCodeAt(0)).toBe(0xfeff);
    expect(out.header).toEqual(ex.EXPORT_COLUMNS.invoices);
    expect(out.records.map((r) => r.number)).toEqual([seeded.a.number, seeded.b.number, seeded.cn.number]);
    const [a, b, cn] = out.records as [Record<string, string>, Record<string, string>, Record<string, string>];
    expect(a).toMatchObject({ kind: "invoice", issued_on: "2026-10-05", status: "paid", is_company: "false", net: "150.00", vat: "24.00", total: "174.00", reverses_number: "" });
    expect(b).toMatchObject({ kind: "invoice", issued_on: "2026-10-12", status: "open", total: "121.00" });
    expect(b.due_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(b.payment_reference).toMatch(/^\+\+\+|^'\+\+\+/);
    expect(cn).toMatchObject({ kind: "credit_note", issued_on: "2026-10-20", status: "paid", net: "-50.00", vat: "-3.00", total: "-53.00", reverses_number: seeded.a.number });
    const grossOfView = (await octoberSummary()).reduce((s, r) => s + r.gross, 0);
    expect(out.records.reduce((s, r) => s + euros(r.total), 0)).toBe(grossOfView);
  });
});

describe("invoice_lines", () => {
  it("one row per line, numbered per document; sums per rate and kind equal v_finance_vat_summary", async () => {
    const out = await exportOf("invoice_lines");
    expect(out.header).toEqual(ex.EXPORT_COLUMNS.invoice_lines);
    expect(out.row.rowCount).toBe(4);
    expect(out.records.filter((r) => r.number === seeded.a.number).map((r) => r.line_no)).toEqual(["1", "2"]);
    const cnLine = out.records.find((r) => r.number === seeded.cn.number)!;
    expect(cnLine).toMatchObject({ line_no: "1", quantity: "-1", vat_rate: "6", net: "-50.00", vat: "-3.00", gross: "-53.00" });
    const view = await octoberSummary();
    for (const v of view) {
      const kindOf = (n: string) => (n.startsWith("CN-") ? "credit_note" : "invoice");
      const lines = out.records.filter((r) => kindOf(r.number!) === v.kind && Number(r.vat_rate) === v.rate);
      expect(lines.reduce((s, r) => s + euros(r.net), 0), `${v.kind} ${v.rate}`).toBe(v.net);
      expect(lines.reduce((s, r) => s + euros(r.vat), 0)).toBe(v.vat);
      expect(lines.reduce((s, r) => s + euros(r.gross), 0)).toBe(v.gross);
    }
  });
});

describe("vat_summary", () => {
  it("equals v_finance_vat_summary for a month-aligned period", async () => {
    const out = await exportOf("vat_summary");
    expect(out.header).toEqual(ex.EXPORT_COLUMNS.vat_summary);
    const view = await octoberSummary();
    expect(out.row.rowCount).toBe(view.length);
    expect(view).toHaveLength(3);
    const fromCsv = out.records.map((r) => ({ month: r.month, kind: r.kind, rate: Number(r.vat_rate), net: euros(r.net), vat: euros(r.vat), gross: euros(r.gross) }));
    expect(fromCsv.every((r) => r.month === "2026-10-01")).toBe(true);
    const key = (r: { kind: string; rate: number }) => `${r.kind}:${r.rate}`;
    const sort = <T extends { kind: string; rate: number }>(rows: T[]) => [...rows].sort((x, y) => key(x).localeCompare(key(y)));
    expect(sort(fromCsv).map(({ month: _m, ...r }) => r)).toEqual(sort(view));
    expect(fromCsv.find((r) => r.kind === "credit_note")).toMatchObject({ rate: 6, net: -5_000, vat: -300, gross: -5_300 });
  });
});

describe("payments", () => {
  it("payments received by Brussels day plus money returned on paid credit notes (negative)", async () => {
    const out = await exportOf("payments");
    expect(out.header).toEqual(ex.EXPORT_COLUMNS.payments);
    expect(out.row.rowCount).toBe(2);
    expect(out.records[0]).toEqual({
      paid_on: "2026-10-05",
      provider: "mollie",
      method: "bancontact",
      provider_payment_id: seeded.a.providerPaymentId,
      order_id: seeded.a.orderId,
      invoice_number: seeded.a.number,
      amount: "174.00",
    });
    expect(out.records[1]).toMatchObject({ paid_on: "2026-10-21", provider: "mollie", provider_payment_id: seeded.refundProviderId, order_id: seeded.a.orderId, invoice_number: seeded.cn.number, amount: "-53.00" });
  });
});

describe("finance.build_export", () => {
  it("a double run stores one file (kind export, no person, expires after 7 days)", async () => {
    const out = await exportOf("invoices");
    expect(out.first).toMatchObject({ status: "done", rowCount: 3 });
    expect(out.second).toMatchObject({ status: "already_done", fileId: out.row.fileId });
    const stored = await h.db.select().from(files).where(and(eq(files.kind, "export"), eq(files.id, out.row.fileId!)));
    expect(stored).toHaveLength(1);
    expect(out.file).toMatchObject({ kind: "export", mime: "text/csv", personId: null, name: "beam-invoices-2026-10-01-2026-10-31.csv" });
    const ttl = out.file.expiresAt!.getTime() - out.file.createdAt.getTime();
    expect(Math.abs(ttl - 7 * 86_400_000)).toBeLessThan(60_000);
  });

  it("reads in keyset pages: pages of one row give the same file as one page", async () => {
    for (const kind of ["invoices", "invoice_lines", "vat_summary", "payments"] as const) {
      const whole = await ex.buildExportCsv(h.db, kind, OCT);
      const paged = await ex.buildExportCsv(h.db, kind, OCT, { pageSize: 1 });
      expect(whole.ok && paged.ok, kind).toBe(true);
      if (whole.ok && paged.ok) {
        expect(paged.rowCount, kind).toBe(whole.rowCount);
        expect(decoder.decode(paged.bytes), kind).toBe(decoder.decode(whole.bytes));
      }
    }
  });

  it("an empty period gives a header-only file with zero rows", async () => {
    const out = await exportOf("payments", { from: "2025-01-01", to: "2025-01-31" });
    expect(out.row).toMatchObject({ status: "done", rowCount: 0 });
    expect(out.text).toBe(`﻿${ex.EXPORT_COLUMNS.payments.join(";")}\r\n`);
  });

  it("a file above the size limit fails with export_too_large; a Release 3 kind fails as unavailable", async () => {
    expect(await ex.buildExportCsv(h.db, "invoice_lines", OCT, { maxBytes: 200 })).toEqual({ ok: false, error: "finance.errors.export_too_large" });
    const user = await signInStaff(jar, h.db, "finance");
    const [row] = await h.db.insert(financeExports).values({ kind: "breakage", periodFrom: OCT.from, periodTo: OCT.to, requestedByUserId: user.id }).returning();
    const { first } = await runJobTwice(h.db, "finance.build_export", { exportId: row!.id });
    expect(first).toEqual({ status: "failed", error: "finance.errors.export_kind_unavailable" });
    const [after] = await h.db.select().from(financeExports).where(eq(financeExports.id, row!.id));
    expect(after).toMatchObject({ status: "failed", error: "finance.errors.export_kind_unavailable", fileId: null });
  });

  it("after the last attempt the export is failed with the error", async () => {
    const user = await signInStaff(jar, h.db, "finance");
    const [row] = await h.db.insert(financeExports).values({ kind: "invoices", periodFrom: OCT.from, periodTo: OCT.to, requestedByUserId: user.id }).returning();
    await ex.failExport(h.db, row!.id, "boom");
    const [after] = await h.db.select().from(financeExports).where(eq(financeExports.id, row!.id));
    expect(after).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("requestFinanceExport", () => {
  it("refuses a period over 366 days and one that ends before it starts", async () => {
    const tooLong = await actions.requestFinanceExport({ kind: "invoices", from: "2026-01-01", to: "2027-01-02" });
    expect(tooLong).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(JSON.stringify(tooLong)).toContain("finance.errors.period_too_long");
    const backwards = await actions.requestFinanceExport({ kind: "invoices", from: "2026-10-31", to: "2026-10-01" });
    expect(JSON.stringify(backwards)).toContain("finance.errors.period_invalid");
    expect(await actions.requestFinanceExport({ kind: "invoices", from: "2026-01-01", to: "2027-01-01" })).toMatchObject({ ok: true });
    expect(ex.periodError("2024-01-01", "2024-12-31")).toBeNull();
    expect(ex.periodError("2024-01-01", "2025-01-01")).toBe("finance.errors.period_too_long");
    expect(ex.periodError("2026-02-30x", "2026-03-01")).toBe("finance.errors.period_invalid");
  });

  it("writes the export row, the job and the audit row finance.export_requested", async () => {
    const user = await signInStaff(jar, h.db, "finance");
    const { exportId } = ok(await actions.requestFinanceExport({ kind: "vat_summary", from: "2026-07-01", to: "2026-09-30" }));
    const [row] = await h.db.select().from(financeExports).where(eq(financeExports.id, exportId));
    expect(row).toMatchObject({ kind: "vat_summary", periodFrom: "2026-07-01", periodTo: "2026-09-30", status: "queued", requestedByUserId: user.id });
    const audit = await auditRows(h.db, "finance.export_requested", exportId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "finance_export", newValue: { kind: "vat_summary", from: "2026-07-01", to: "2026-09-30" } });
    const listed = await listFinanceExports(h.db);
    expect(listed.find((e) => e.id === exportId)).toMatchObject({ status: "queued", downloadable: false });
  });
});

describe("download", () => {
  const get = (id: string) => route.GET(new Request(`http://localhost/admin/finance/exports/${id}`), { params: Promise.resolve({ id }) });

  it("streams the CSV to reports.finance and audits finance.export_downloaded", async () => {
    const out = await exportOf("invoices");
    const res = await get(out.exportId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="beam-invoices-2026-10-01-2026-10-31.csv"');
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(decoder.decode(await res.arrayBuffer())).toBe(out.text);
    const audit = await auditRows(h.db, "finance.export_downloaded", out.exportId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "finance_export", newValue: { kind: "invoices", rows: 3 } });
    expect((await listFinanceExports(h.db)).find((e) => e.id === out.exportId)).toMatchObject({ status: "done", rowCount: 3, downloadable: true });
  });

  it("is refused without reports.finance and writes no audit row", async () => {
    const out = await exportOf("vat_summary");
    jar.clear();
    await signInStaff(jar, h.db, "customer_service", ["invoices.read", "invoices.issue"]);
    expect((await get(out.exportId)).status).toBe(403);
    jar.clear();
    expect((await get(out.exportId)).status).toBe(401);
    expect(await auditRows(h.db, "finance.export_downloaded", out.exportId)).toHaveLength(0);
  });

  it("404 for an unknown export, 410 while it is not done or after the file expired", async () => {
    expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
    const { exportId } = ok(await actions.requestFinanceExport({ kind: "payments", ...OCT }));
    expect((await get(exportId)).status).toBe(410);
    const out = await exportOf("payments");
    await h.db.update(files).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(files.id, out.row.fileId!));
    expect((await get(out.exportId)).status).toBe(410);
    expect((await listFinanceExports(h.db)).find((e) => e.id === out.exportId)).toMatchObject({ downloadable: false });
    expect(await auditRows(h.db, "finance.export_downloaded", exportId)).toHaveLength(0);
  });
});

describe("exportPresets", () => {
  it("last month, last quarter and last year before a Brussels day", () => {
    expect(ex.exportPresets("2026-11-04")).toEqual({
      last_month: { from: "2026-10-01", to: "2026-10-31" },
      last_quarter: { from: "2026-07-01", to: "2026-09-30" },
      last_year: { from: "2025-01-01", to: "2025-12-31" },
    });
    expect(ex.exportPresets("2026-01-15")).toEqual({
      last_month: { from: "2025-12-01", to: "2025-12-31" },
      last_quarter: { from: "2025-10-01", to: "2025-12-31" },
      last_year: { from: "2025-01-01", to: "2025-12-31" },
    });
    expect(ex.exportPresets("2028-03-10").last_month).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    for (const p of Object.values(ex.exportPresets("2025-01-01"))) expect(ex.periodError(p.from, p.to)).toBeNull();
  });
});
