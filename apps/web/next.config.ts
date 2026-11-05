import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import withSerwistInit from "@serwist/next";
import { config } from "dotenv";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const here = path.dirname(fileURLToPath(import.meta.url));
// Environment lives in the repo root (.env.local), shared by all apps and packages.
config({ path: [path.join(here, "../../.env.local"), path.join(here, "../../.env")], quiet: true });

/** Host of APP_URL; Server Actions accept only this origin (PL-71). */
function appHost(): string | null {
  try {
    return process.env.APP_URL ? new URL(process.env.APP_URL).host : null;
  } catch {
    return null;
  }
}

// Static security headers (PL-67). The per-request CSP with its nonce is set by proxy.ts
// through lib/csp.ts, because a nonce cannot be static.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const host = appHost();

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources (DR-17).
  transpilePackages: ["@beam/config", "@beam/core", "@beam/db", "@beam/email", "@beam/integrations", "@beam/ui"],
  // Native or large server-only packages stay external; mjml is resolvable thanks to W0-0 (DR-17).
  serverExternalPackages: ["pg", "@electric-sql/pglite", "mjml"],
  outputFileTracingRoot: path.join(here, "../.."),
  typedRoutes: true,
  poweredByHeader: false,
  experimental: {
    // 3 MB: forms' `uploadImportCsv` takes a CSV of 1 to 2 MB; the 1 MB default rejects it.
    serverActions: { allowedOrigins: host ? [host] : [], bodySizeLimit: "3mb" },
  },
  headers: () => Promise.resolve([{ source: "/:path*", headers: securityHeaders }]),
};

// Optional plugins, applied only when their source file exists, so the packages that
// write them (site: app/sw.ts; platform-P6: lib/i18n.ts) need no change to this frozen file.
type Plugin = (config: NextConfig) => NextConfig;
const plugins: Plugin[] = [];

if (existsSync(path.join(here, "lib/i18n.ts"))) {
  plugins.push(createNextIntlPlugin("./lib/i18n.ts"));
}

if (existsSync(path.join(here, "app/sw.ts"))) {
  plugins.push(
    withSerwistInit({
      swSrc: "app/sw.ts",
      swDest: "public/sw.js",
      disable: process.env.NODE_ENV === "development",
    }),
  );
}

// Not wrapped with withSentryConfig until a SENTRY_AUTH_TOKEN exists (DR-15).
export default plugins.reduce((acc, plugin) => plugin(acc), nextConfig);
