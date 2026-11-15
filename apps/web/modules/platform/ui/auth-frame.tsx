/**
 * The frame of the sign-in pages (staff and customer): BEAM's space as a navy-tinted photo with
 * the logo and the tagline on the left, the form on a cream panel on the right; on small screens
 * the photo shrinks to a band above the form.
 */
import type { ReactNode } from "react";

export function AuthFrame({ tagline, homeHref, children }: { tagline: string; homeHref: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[1.1fr_1fr]">
      <div className="relative isolate flex min-h-56 flex-col justify-between overflow-hidden bg-[#212842] p-6 text-[#fffaef] sm:p-10">
        {/* eslint-disable-next-line @next/next/no-img-element -- a static brand photo */}
        <img src="/brand/beam-space.webp" alt="" className="absolute inset-0 -z-20 h-full w-full object-cover" />
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[linear-gradient(160deg,rgba(23,28,48,0.55)_0%,rgba(23,28,48,0.75)_55%,rgba(23,28,48,0.95)_100%)]" />
        <a href={homeHref} className="self-start">
          {/* eslint-disable-next-line @next/next/no-img-element -- a static brand file */}
          <img src="/brand/beam-logo-header.png" alt="BEAM" width={567} height={112} className="h-9 w-auto" />
        </a>
        <p className="font-display hidden max-w-md text-5xl leading-tight lg:block">{tagline}</p>
      </div>
      <div className="flex items-center justify-center px-4 py-10 sm:px-10">
        <main id="main-content" className="grid w-full max-w-md gap-6">
          {children}
        </main>
      </div>
    </div>
  );
}
