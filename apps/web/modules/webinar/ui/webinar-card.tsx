/**
 * One webinar in a list (public `/[locale]/webinars`, the portal lists, site's event pages):
 * title, date in Brussels time (or "On demand"), the spoken language and an optional status or
 * availability line, linking to the landing page or the player. A plain server-renderable
 * component without client state; every text arrives formatted.
 */
import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";

export type WebinarCardProps = {
  title: string;
  href: string;
  /** "Tuesday 12 January 2027 at 19:00" or "On demand". */
  when: string;
  /** "In Dutch". */
  language: string;
  /** A badge such as "Live now" or "Registered". */
  badge?: string | null;
  /** Extra lines (availability, views left). */
  details?: string[];
  /** The link text ("View and register", "Watch"). */
  action: string;
  /** Extra controls under the link (cancel, add to calendar). */
  children?: ReactNode;
};

export function WebinarCard({ title, href, when, language, badge, details = [], action, children }: WebinarCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          <span>{title}</span>
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>{when}</p>
        <p className="text-muted-foreground">{language}</p>
        {details.map((d) => (
          <p key={d} className="text-muted-foreground">
            {d}
          </p>
        ))}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Link href={href as Route} className="font-medium underline underline-offset-2">
            {action}
          </Link>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}
