/**
 * `pnpm exec tsx apps/web/scripts/training-screenshots.ts [--only <guide>] [--placeholders]`
 * (platform-P11b; blueprint 79).
 *
 * Captures the screenshots of the training guides in `docs/handbook/training/` from a running
 * BEAM (`BASE_URL`, default `http://localhost:3000`) on `beam_dev` with the demo seed
 * (`pnpm seed:demo`), in the Dutch UI the staff use. For every shot it signs in as an active
 * demo user of the shot's role by creating a session row directly in the database
 * (`DATABASE_URL_UNPOOLED` or `DATABASE_URL`; staff sessions count as MFA-verified), so no
 * password or authenticator is needed, opens the page at 1440 x 900, waits for the network to
 * settle and writes `docs/handbook/training/img/<file>`. The sessions are deleted at the end.
 * Never run it against production (refused when `APP_ENV=production`).
 *
 * `--placeholders` writes a plain grey PNG for every shot whose image is missing, without a
 * browser or database, so the guides render before the first real capture. Re-run the capture
 * after a UI change and commit the images.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

export const TRAINING_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/handbook/training");
export const IMG_DIR = path.join(TRAINING_DIR, "img");

/** The ten pages of the training set: the README and one guide per blueprint 79 topic. */
export const GUIDES = [
  "daily-use",
  "booking",
  "customer-management",
  "campaigns",
  "reporting",
  "ai-tools",
  "administration",
  "troubleshooting",
  "privacy-security",
] as const;
export type Guide = (typeof GUIDES)[number];

export type ShotRole = "owner" | "technical_admin" | "management" | "finance" | "reception" | "customer_service" | "marketing" | "customer";

export type Shot = {
  /** File name under `img/`, `<guide>-<what>.png`. */
  file: string;
  guide: Guide;
  /** The path opened (admin paths have no locale; portal paths start with `/nl`). */
  path: string;
  /** The demo user the page is captured as. */
  role: ShotRole;
  caption: string;
};

export const SHOTS: readonly Shot[] = [
  { file: "daily-use-dashboard.png", guide: "daily-use", path: "/admin/dashboard", role: "reception", caption: "Dashboard, view Vandaag" },
  { file: "daily-use-checkin.png", guide: "daily-use", path: "/admin/bookings/checkin", role: "reception", caption: "Onthaal: today's sessions and check-in" },
  { file: "daily-use-pos.png", guide: "daily-use", path: "/admin/pos", role: "reception", caption: "Onthaal (point of sale): basket and payment" },
  { file: "daily-use-tasks.png", guide: "daily-use", path: "/admin/tasks", role: "reception", caption: "Taken, tab Mijn taken" },
  { file: "booking-sessions.png", guide: "booking", path: "/admin/sessions", role: "reception", caption: "Sessies: the planned sessions" },
  { file: "booking-bookings.png", guide: "booking", path: "/admin/bookings", role: "customer_service", caption: "Boekingen with filters" },
  { file: "booking-new.png", guide: "booking", path: "/admin/bookings/new", role: "customer_service", caption: "Nieuwe boeking" },
  { file: "booking-waitlist.png", guide: "booking", path: "/admin/waitlist", role: "customer_service", caption: "Wachtlijsten" },
  { file: "booking-portal.png", guide: "booking", path: "/nl/account/book", role: "customer", caption: "What the customer sees: Boeken in the portal" },
  { file: "customer-management-persons.png", guide: "customer-management", path: "/admin/persons", role: "customer_service", caption: "Personen: search and filters" },
  { file: "customer-management-new-person.png", guide: "customer-management", path: "/admin/persons/new", role: "customer_service", caption: "Nieuwe persoon" },
  { file: "customer-management-duplicates.png", guide: "customer-management", path: "/admin/persons/duplicates", role: "customer_service", caption: "Possible duplicates" },
  { file: "customer-management-inbox.png", guide: "customer-management", path: "/admin/inbox", role: "customer_service", caption: "Inbox" },
  { file: "campaigns-list.png", guide: "campaigns", path: "/admin/campaigns", role: "marketing", caption: "Campagnes" },
  { file: "campaigns-new.png", guide: "campaigns", path: "/admin/campaigns/new", role: "marketing", caption: "Nieuwe campagne" },
  { file: "campaigns-templates.png", guide: "campaigns", path: "/admin/templates", role: "marketing", caption: "E-mailsjablonen" },
  { file: "campaigns-segments.png", guide: "campaigns", path: "/admin/segments", role: "marketing", caption: "Segmenten" },
  { file: "reporting-reports.png", guide: "reporting", path: "/admin/reports", role: "management", caption: "Rapporten" },
  { file: "reporting-revenue.png", guide: "reporting", path: "/admin/reports/revenue", role: "management", caption: "Omzet with period and VAT switch" },
  { file: "reporting-finance-dashboard.png", guide: "reporting", path: "/admin/finance/dashboard", role: "finance", caption: "Financiën: Dashboard" },
  { file: "reporting-exports.png", guide: "reporting", path: "/admin/reports/exports", role: "management", caption: "Exports" },
  { file: "ai-tools-site.png", guide: "ai-tools", path: "/admin/site", role: "marketing", caption: "Website pages, where Vraag het Claude lives" },
  { file: "ai-tools-usage.png", guide: "ai-tools", path: "/admin/system/ai", role: "owner", caption: "AI-gebruik: the AI register and this month's use" },
  { file: "administration-users.png", guide: "administration", path: "/admin/settings/users", role: "owner", caption: "Medewerkers" },
  { file: "administration-roles.png", guide: "administration", path: "/admin/settings/roles", role: "owner", caption: "Rollen" },
  { file: "administration-settings.png", guide: "administration", path: "/admin/settings", role: "owner", caption: "Instellingen" },
  { file: "administration-go-live.png", guide: "administration", path: "/admin/system/go-live", role: "owner", caption: "Go-live-checklist" },
  { file: "troubleshooting-system.png", guide: "troubleshooting", path: "/admin/system", role: "technical_admin", caption: "Systeem: health overview" },
  { file: "troubleshooting-jobs.png", guide: "troubleshooting", path: "/admin/system/jobs", role: "technical_admin", caption: "Achtergrondtaken" },
  { file: "troubleshooting-support.png", guide: "troubleshooting", path: "/admin/system/support", role: "technical_admin", caption: "Supportregister" },
  { file: "troubleshooting-my-support.png", guide: "troubleshooting", path: "/admin/support", role: "reception", caption: "Mijn gemelde problemen" },
  { file: "privacy-security-requests.png", guide: "privacy-security", path: "/admin/privacy", role: "owner", caption: "Privacyverzoeken" },
  { file: "privacy-security-security.png", guide: "privacy-security", path: "/admin/system/security", role: "technical_admin", caption: "Beveiliging" },
  { file: "privacy-security-audit.png", guide: "privacy-security", path: "/admin/system/audit", role: "technical_admin", caption: "Auditlog" },
  { file: "privacy-security-retention.png", guide: "privacy-security", path: "/admin/privacy/retention", role: "owner", caption: "Bewaartermijnen" },
];

export const VIEWPORT = { width: 1440, height: 900 } as const;

// ---------------------------------------------------------------------------
// Placeholder PNG (no dependency): one grey image with a darker frame
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

/** An 8-bit greyscale PNG of `width` x `height`: light grey with a 12-pixel darker frame. */
export function placeholderPng(width = 960, height = 600): Buffer {
  const frame = 12;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const edge = x < frame || y < frame || x >= width - frame || y >= height - frame;
      raw[row + 1 + x] = edge ? 0xb0 : 0xe8;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const exists = (file: string) => stat(file).then(() => true, () => false);

/** Writes a placeholder for every shot without an image; returns the files written. */
export async function writePlaceholders(dir: string = IMG_DIR, shots: readonly Shot[] = SHOTS): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  const png = placeholderPng();
  for (const s of shots) {
    const file = path.join(dir, s.file);
    if (await exists(file)) continue;
    await writeFile(file, png);
    written.push(s.file);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Capture (Playwright against a running app)
// ---------------------------------------------------------------------------

export type CaptureArgs = { only: Guide | null; placeholders: boolean };

export function parseArgs(argv: readonly string[]): CaptureArgs {
  const i = argv.indexOf("--only");
  const only = i >= 0 ? argv[i + 1] : undefined;
  if (only !== undefined && !(GUIDES as readonly string[]).includes(only)) {
    throw new Error(`usage: training-screenshots.ts [--only ${GUIDES.join("|")}] [--placeholders]`);
  }
  return { only: (only as Guide | undefined) ?? null, placeholders: argv.includes("--placeholders") };
}

/** `server-only` throws outside a React Server Component build (same stub as vitest, DR-9). */
function stubServerOnly(): void {
  const hook = `export async function resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    return next(specifier, context);
  }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

async function capture(shots: readonly Shot[], baseUrl: string): Promise<number> {
  stubServerOnly();
  const [{ chromium }, { getDbHandle }, { users }, ctxLib, auth, authConfig] = await Promise.all([
    import("@playwright/test"),
    import("@beam/db"),
    import("@beam/db/schema"),
    import("@/lib/ctx"),
    import("@/lib/auth"),
    import("@/lib/auth-config"),
  ]);
  const { and, asc, eq } = ctxLib;
  const handle = await getDbHandle();
  const tokens: string[] = [];
  const cookieName = authConfig.sessionCookieName({ APP_URL: baseUrl });
  const browser = await chromium.launch();
  let failures = 0;
  try {
    const sessionFor = new Map<ShotRole, string>();
    for (const role of new Set(shots.map((s) => s.role))) {
      const where =
        role === "customer"
          ? and(eq(users.audience, "customer"), eq(users.status, "active"))
          : and(eq(users.audience, "staff"), eq(users.status, "active"), eq(users.roleKey, role));
      const [user] = await handle.db.select({ id: users.id }).from(users).where(where).orderBy(asc(users.createdAt)).limit(1);
      if (!user) {
        console.error(`training-screenshots: no active demo user with role ${role}; run pnpm seed:demo`);
        continue;
      }
      const now = new Date();
      const { token } = await auth.createAuthSession(handle.db, {
        userId: user.id,
        audience: role === "customer" ? "customer" : "staff",
        roleKey: role === "customer" ? null : role,
        now,
        mfaAt: role === "customer" ? null : now,
        userAgent: "beam-training-screenshots",
      });
      tokens.push(token);
      sessionFor.set(role, token);
    }
    await mkdir(IMG_DIR, { recursive: true });
    for (const shot of shots) {
      const token = sessionFor.get(shot.role);
      if (!token) {
        failures += 1;
        continue;
      }
      const context = await browser.newContext({ viewport: VIEWPORT, locale: "nl-BE", timezoneId: "Europe/Brussels", extraHTTPHeaders: { "accept-language": "nl-BE" } });
      await context.addCookies([{ name: cookieName, value: token, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      try {
        const res = await page.goto(`${baseUrl}${shot.path}`, { waitUntil: "networkidle", timeout: 30_000 });
        if (!res || res.status() >= 400 || new URL(page.url()).pathname !== new URL(`${baseUrl}${shot.path}`).pathname) {
          throw new Error(`landed on ${page.url()} (${res?.status() ?? "no response"})`);
        }
        await page.screenshot({ path: path.join(IMG_DIR, shot.file) });
        console.log(`training-screenshots: ${shot.file}`);
      } catch (error) {
        failures += 1;
        console.error(`training-screenshots: ${shot.file} failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    for (const token of tokens) await auth.deleteSessionByToken(handle.db, token).catch(() => undefined);
    await handle.close();
  }
  return failures;
}

async function main(argv: string[]): Promise<number> {
  let args: CaptureArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  const shots = SHOTS.filter((s) => !args.only || s.guide === args.only);
  if (args.placeholders) {
    const written = await writePlaceholders(IMG_DIR, shots);
    console.log(`training-screenshots: ${written.length} placeholders written`);
    return 0;
  }
  const { config } = await import("dotenv");
  config({ path: [path.resolve(TRAINING_DIR, "../../../.env.local"), ".env.local"], quiet: true });
  if (process.env.APP_ENV === "production") {
    console.error("training-screenshots: refused, APP_ENV=production (capture from beam_dev)");
    return 2;
  }
  if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
  const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const failures = await capture(shots, baseUrl);
  console.log(`training-screenshots: ${shots.length - failures} of ${shots.length} captured`);
  return failures ? 1 : 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
