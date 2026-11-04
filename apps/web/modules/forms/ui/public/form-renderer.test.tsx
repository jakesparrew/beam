// @vitest-environment jsdom
/** forms-P4: the public renderer in jsdom (forms spec section 5 "Public", rules U1, U7, R3). */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "@beam/core/i18n";
import { seedDefinitions } from "@beam/core/forms";
import { FormRenderer } from "./form-renderer";

const labels = (MESSAGES.en!.forms as { forms: { public: Record<string, string> } }).forms.public;
const contact = seedDefinitions().contact;

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let submitReply: { status: number; body: unknown } = { status: 200, body: { endingKey: "thanks", completedNow: true, pendingConfirmation: false, guardianConsent: false } };

function reply(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  submitReply = { status: 200, body: { endingKey: "thanks", completedNow: true, pendingConfirmation: false, guardianConsent: false } };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/view")) return Promise.resolve(reply(204, null));
      if (url.endsWith("/start")) return Promise.resolve(reply(200, { submissionId: "11111111-1111-4111-8111-111111111111" }));
      if (url.endsWith("/save")) return Promise.resolve(reply(200, { next: { end: true } }));
      if (url.endsWith("/submit")) return Promise.resolve(reply(submitReply.status, submitReply.body));
      return Promise.resolve(reply(404, null));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderContact() {
  return render(<FormRenderer slug="contact" kind="lead" locale="en" definition={contact.definition} scoring={contact.scoring} labels={labels} mode="page" />);
}

async function fillAndSend() {
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "lotte@example.com" } });
  fireEvent.change(screen.getByLabelText(/First name/), { target: { value: "Lotte" } });
  fireEvent.change(screen.getByLabelText(/Your message/), { target: { value: "Hello" } });
  await act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    return Promise.resolve();
  });
}

describe("FormRenderer", () => {
  it("renders a visible label for every input, required marked in text, and the progress text", () => {
    renderContact();
    expect(screen.getByLabelText(/Email/)).toHaveProperty("type", "email");
    expect(screen.getAllByText("(required)").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("Step 1 of 1")).toBeTruthy();
  });

  it("does not start on page view; starts on the first answer", async () => {
    renderContact();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/view"))).toBe(true));
    expect(calls.some((c) => c.url.endsWith("/start"))).toBe(false);
    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: "L" } });
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/start"))).toHaveLength(1));
    expect(calls.find((c) => c.url.endsWith("/start"))!.body).toMatchObject({ locale: "en", honeypot: "" });
  });

  it("an empty submit moves focus to the error summary with links to the fields", async () => {
    renderContact();
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      return Promise.resolve();
    });
    const summary = document.querySelector("[data-error-summary]") as HTMLElement;
    expect(summary).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(summary.querySelectorAll("a[href^='#']").length).toBeGreaterThanOrEqual(3);
    expect(calls.some((c) => c.url.endsWith("/save"))).toBe(false);
  });

  it("beam-form:completed fires once after a completed submit with only slug, kind, locale and endingKind", async () => {
    const listener = vi.fn();
    window.addEventListener("beam-form:completed", listener);
    renderContact();
    await fillAndSend();
    await waitFor(() => expect(screen.getByText("Thank you for your message")).toBeTruthy());
    expect(listener).toHaveBeenCalledTimes(1);
    const detail = (listener.mock.calls[0]![0] as CustomEvent).detail as Record<string, unknown>;
    expect(detail).toEqual({ slug: "contact", kind: "lead", locale: "en", endingKind: "thank_you" });
    const submit = calls.find((c) => c.url.endsWith("/submit"))!;
    expect(submit.body).toMatchObject({ submissionId: "11111111-1111-4111-8111-111111111111", honeypot: "", answers: { email: "lotte@example.com", first_name: "Lotte", message: "Hello" } });
    window.removeEventListener("beam-form:completed", listener);
  });

  it("emits nothing for a repeated or bot-dropped submit (completedNow false)", async () => {
    submitReply = { status: 200, body: { endingKey: "thanks", completedNow: false, pendingConfirmation: false, guardianConsent: false } };
    const listener = vi.fn();
    window.addEventListener("beam-form:completed", listener);
    renderContact();
    await fillAndSend();
    await waitFor(() => expect(screen.getByText("Thank you for your message")).toBeTruthy());
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener("beam-form:completed", listener);
  });

  it("emits nothing after a failed submit and shows the error", async () => {
    submitReply = { status: 500, body: { ok: false, error: { code: "internal", message: "req_1" } } };
    const listener = vi.fn();
    window.addEventListener("beam-form:completed", listener);
    renderContact();
    await fillAndSend();
    await waitFor(() => expect(screen.getByText(labels.failed!)).toBeTruthy());
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener("beam-form:completed", listener);
  });

  it("shows the rate limit message on 429 and the closed message on 410", async () => {
    submitReply = { status: 429, body: { ok: false, error: { code: "rate_limited", message: "rate_limited" } } };
    renderContact();
    await fillAndSend();
    await waitFor(() => expect(screen.getByText(labels.rate_limited!)).toBeTruthy());
    cleanup();
    submitReply = { status: 410, body: { ok: false, error: { code: "form_closed", message: "form_closed" } } };
    renderContact();
    await fillAndSend();
    await waitFor(() => expect(screen.getByText(labels.closed_title!)).toBeTruthy());
  });

  it("hides known fields behind the prefill summary; Not you? shows them again", () => {
    render(
      <FormRenderer
        slug="contact"
        kind="lead"
        locale="en"
        definition={contact.definition}
        scoring={contact.scoring}
        labels={labels}
        mode="page"
        identityToken="pt-token"
        prefill={{ firstName: "Jana", maskedEmail: "j•••@example.com", known: ["email", "first_name"] }}
      />,
    );
    expect(screen.getByText(/Filling in as Jana \(j•••@example.com\)/)).toBeTruthy();
    expect(screen.queryByLabelText(/Email/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not you?" }));
    expect(screen.getByLabelText(/Email/)).toBeTruthy();
  });
});
