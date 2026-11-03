import type { ReactNode } from "react";

export const metadata = {
  title: "BEAM Platform",
  description: "BEAM Vitality Center platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="nl">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 32 }}>{children}</body>
    </html>
  );
}
