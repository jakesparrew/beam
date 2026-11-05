/**
 * The click-to-load notice of the webinar player (webinar spec 5.3 and 9.3, wording version
 * `player_notice_v1`): before anything from YouTube loads, the viewer reads that Google receives
 * connection data when the video plays, and chooses to load it. Nothing is fetched from Google
 * until the button is pressed; the version is stored on the `started` interaction.
 *
 * A plain presentational component (no hooks), rendered by the client `WebinarPlayer`. Every text
 * comes from the server as a prop. The button is a native `<button>`, so it is keyboard operable
 * and gets the shared visible focus ring.
 */
import { Button } from "@beam/ui";

export const PLAYER_NOTICE_WORDING = "player_notice_v1";

export type PlayerNoticeLabels = { title: string; body: string; accept: string; privacyLink: string };

export function PlayerNotice({ labels, privacyHref, onAccept, headingId }: { labels: PlayerNoticeLabels; privacyHref: string; onAccept: () => void; headingId: string }) {
  return (
    <section
      aria-labelledby={headingId}
      data-wording={PLAYER_NOTICE_WORDING}
      className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-lg border border-border bg-muted p-6 text-center"
    >
      <h2 id={headingId} className="text-lg font-semibold text-foreground">
        {labels.title}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">{labels.body}</p>
      <Button type="button" onClick={onAccept}>
        {labels.accept}
      </Button>
      <a href={privacyHref} className="text-sm underline underline-offset-2">
        {labels.privacyLink}
      </a>
    </section>
  );
}
