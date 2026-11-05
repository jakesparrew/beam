"use client";

/**
 * The locked card "n sensitive answers" of the submission detail (forms spec section 5, SE3;
 * forms-P6). Reveal calls `revealSensitiveAnswers`, which decrypts through `readSensitive` and is
 * audited as `sensitive.read`; the values live only in this component's state and are dropped on
 * Hide or when the page is left. Without `persons.sensitive_read` the button is not offered.
 */
import { useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, toast } from "@beam/ui";
import { revealSensitiveAnswers } from "../../actions";
import { lbl, type Labels } from "./issues-panel";

export type SensitiveCardProps = { submissionId: string; count: number; canReveal: boolean; anonymous: boolean; labels: Labels };

export function SensitiveCard({ submissionId, count, canReveal, anonymous, labels }: SensitiveCardProps) {
  const [answers, setAnswers] = useState<{ fieldKey: string; label: string; value: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const reveal = async () => {
    setBusy(true);
    const r = await revealSensitiveAnswers({ submissionId });
    setBusy(false);
    if (r.ok) setAnswers(r.data.answers);
    else toast.error(lbl(labels, `builder.error.${r.error.code}`));
  };
  return (
    <Card data-sensitive-card={answers ? "revealed" : "locked"}>
      <CardHeader>
        <CardTitle>{lbl(labels, "submissions.sensitive_title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm font-medium">{lbl(labels, "submissions.sensitive_count", { n: count })}</p>
        {answers ? (
          <>
            <dl className="grid gap-2 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              {answers.map((a) => (
                <div key={a.fieldKey} className="contents">
                  <dt className="text-muted-foreground">{a.label}</dt>
                  <dd>{a.value || "—"}</dd>
                </div>
              ))}
            </dl>
            <div>
              <Button type="button" variant="outline" onClick={() => setAnswers(null)}>
                {lbl(labels, "submissions.hide")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{lbl(labels, "submissions.sensitive_locked")}</p>
            {anonymous ? (
              <p className="text-sm">{lbl(labels, "submissions.reveal_anonymous")}</p>
            ) : canReveal ? (
              <div>
                <Button type="button" disabled={busy} onClick={() => void reveal()}>
                  {lbl(labels, "submissions.reveal")}
                </Button>
              </div>
            ) : (
              <p className="text-sm">{lbl(labels, "submissions.reveal_no_permission")}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
