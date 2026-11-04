import { ImageResponse } from "next/og";

/**
 * PWA icons (site spec section 4, site-P5): `/pwa-icon/192.png`, `/pwa-icon/512.png` and
 * `/pwa-icon/512-maskable.png` drawn with `ImageResponse` until BEAM supplies brand PNGs in
 * `public/icons/`. The maskable icon keeps the mark inside the central 80 % safe zone on a
 * full-bleed background. The `.png` suffix keeps the request outside the locale proxy.
 */
export const dynamic = "force-static";

const ICONS = {
  "192.png": { size: 192, maskable: false },
  "512.png": { size: 512, maskable: false },
  "512-maskable.png": { size: 512, maskable: true },
} as const;

type IconName = keyof typeof ICONS;

export function generateStaticParams(): { size: IconName }[] {
  return (Object.keys(ICONS) as IconName[]).map((size) => ({ size }));
}

const BACKGROUND = "#0e6549";
const FOREGROUND = "#fcfcf9";

export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }): Promise<Response> {
  const { size: name } = await params;
  const icon = ICONS[name as IconName];
  if (!icon) return new Response("Not found", { status: 404 });
  const { size, maskable } = icon;
  const fontSize = Math.round(size * (maskable ? 0.22 : 0.28));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BACKGROUND,
          borderRadius: maskable ? 0 : Math.round(size * 0.2),
        }}
      >
        <div style={{ display: "flex", color: FOREGROUND, fontSize, fontWeight: 700, letterSpacing: Math.round(fontSize * 0.04) }}>BEAM</div>
      </div>
    ),
    { width: size, height: size, headers: { "cache-control": "public, max-age=86400, immutable" } },
  );
}
