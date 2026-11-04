/**
 * The runtime payments fake's hosted pay page (runbook BS-9, section 1.5). Development and e2e
 * only: it answers 404 when `APP_ENV=production` and for ids the fake does not hold.
 *
 * `GET` shows the payment amount and three buttons, `Pay`, `Fail` and `Cancel`
 * (`data-testid="fake-pay-paid|failed|cancelled"`, the fake outcome); `?kind=terminal` shows the
 * same page for a terminal payment. `POST` (the button's form) sets the fake status, posts
 * `id=<id>` to the payment's webhook URL exactly as Mollie does (in process, through the Mollie
 * webhook route), then redirects to the payment's `redirectUrl` (`303`). The page is a dev tool,
 * so its few words are not in the catalogues.
 */
import { createPaymentsFake, type FakeOutcome } from "@beam/integrations/payments";
import { POST as mollieWebhook } from "../../../webhooks/mollie/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const OUTCOMES: { outcome: FakeOutcome; label: string }[] = [
  { outcome: "paid", label: "Pay" },
  { outcome: "failed", label: "Fail" },
  { outcome: "cancelled", label: "Cancel" },
];

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function isProduction(): boolean {
  return process.env.APP_ENV === "production";
}

function page(input: { id: string; amount: string; description: string; kind: string; action: string }): string {
  const buttons = OUTCOMES.map(
    (o) =>
      `<button type="submit" name="outcome" value="${o.outcome}" data-testid="fake-pay-${o.outcome}" style="min-height:44px;margin:4px;padding:8px 20px;font-size:16px">${o.label}</button>`,
  ).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fake payment</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1f2933;background:#fff">
<main>
<h1 style="font-size:22px">Fake ${input.kind === "terminal" ? "terminal " : ""}payment</h1>
<p data-testid="fake-pay-amount" style="font-size:28px;margin:8px 0">${escapeHtml(input.amount)}</p>
<p>${escapeHtml(input.description)}</p>
<p style="color:#52606d;font-size:13px">${escapeHtml(input.id)}</p>
<form method="post" action="${escapeHtml(input.action)}">${buttons}</form>
</main>
</body></html>`;
}

export async function GET(req: Request, { params }: RouteContext): Promise<Response> {
  if (isProduction()) return notFound();
  const { id } = await params;
  const record = createPaymentsFake().payment(id);
  if (!record) return notFound();
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? record.kind;
  const amount = new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" }).format(record.amountCents / 100);
  const action = `${url.pathname}${url.search}`;
  return new Response(page({ id, amount, description: record.description, kind, action }), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(req: Request, { params }: RouteContext): Promise<Response> {
  if (isProduction()) return notFound();
  const { id } = await params;
  const fake = createPaymentsFake();
  const record = fake.payment(id);
  if (!record) return notFound();
  const form = new URLSearchParams(await req.text());
  const outcome = form.get("outcome") as FakeOutcome | null;
  if (!outcome || !OUTCOMES.some((o) => o.outcome === outcome)) return new Response("Unknown outcome", { status: 400 });
  fake.settle(id, outcome);

  const origin = new URL(req.url).origin;
  const webhookUrl = new URL(record.webhookUrl || "/api/webhooks/mollie", origin);
  await mollieWebhook(
    new Request(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id }).toString(),
    }),
  );
  const target = record.redirectUrl ? new URL(record.redirectUrl, origin) : new URL("/", origin);
  return Response.redirect(target.toString(), 303);
}
