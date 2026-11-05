import { FAKE_RESEND_WEBHOOK_SECRET } from "@beam/integrations/resend";
import { describe, expect, it } from "vitest";

describe("fix-w21-platform-wiring: app and e2e configuration", () => {
  it("next.config accepts Server Action bodies of up to 3 MB (forms CSV import)", async () => {
    const { default: nextConfig } = await import("./next.config");
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe("3mb");
  });

  it("the Playwright webServer runs analytics in production mode and verifies the fake Resend webhooks", async () => {
    const { default: pw } = await import("./playwright.config");
    const server = Array.isArray(pw.webServer) ? pw.webServer[0] : pw.webServer;
    expect(server?.env).toMatchObject({ INTEGRATIONS: "fake", BEAM_ANALYTICS_PRODUCTION: "1" });
    expect(server?.env?.RESEND_WEBHOOK_SECRET).toBe(process.env.RESEND_WEBHOOK_SECRET || FAKE_RESEND_WEBHOOK_SECRET);
  });
});
