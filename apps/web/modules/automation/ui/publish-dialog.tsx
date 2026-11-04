"use client";
/**
 * The publish dialog of the editor (automation spec 5, A-2, A-3, A-40): a change note, the
 * "migrate N active enrolments" checkbox and the list of missing translations per template,
 * which blocks the button (so does any other error of the saved draft, or unsaved changes).
 * Posts `publishVersion` and refreshes the page on success.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FormField,
  Textarea,
} from "@beam/ui";
import { publishVersion } from "../actions";
import { errorText, fill, issueText, type IssueLike, type Labels } from "./outcome-badge";

export function PublishDialog({
  automationId,
  migratableCount,
  issues,
  dirty,
  labels: l,
}: {
  automationId: string;
  migratableCount: number;
  /** Issues of the saved draft. */
  issues: IssueLike[];
  /** The form holds changes that are not saved yet. */
  dirty: boolean;
  labels: Labels;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const missing = issues.filter((i) => i.code === "translation_missing" && i.severity === "error");
  const others = issues.filter((i) => i.severity === "error" && i.code !== "translation_missing");
  const blocked = dirty || missing.length > 0 || others.length > 0;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const changeNote = String(form.get("changeNote") ?? "").trim();
      const r = await publishVersion({ automationId, migrateActive: form.get("migrateActive") === "on", ...(changeNote ? { changeNote } : {}) });
      if (r.ok) {
        setDone(r.data.version);
        router.refresh();
      } else setError(errorText(r.error, l));
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setError(null);
          setDone(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button data-testid="publish-open">{l["publish.open"]}</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{l["publish.title"]}</DialogTitle>
            <DialogDescription>{l["publish.body"]}</DialogDescription>
          </DialogHeader>
          {done !== null ? (
            <Alert role="status" data-testid="publish-done">
              <AlertDescription>{fill(l["publish.published"], { version: done })}</AlertDescription>
            </Alert>
          ) : (
            <>
              {dirty ? <p className="text-sm text-destructive">{l["publish.save_first"]}</p> : null}
              {missing.length ? (
                <Alert variant="destructive" data-testid="publish-missing">
                  <AlertTitle>{l["publish.missing_title"]}</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {missing.map((i, n) => (
                        <li key={n}>{fill(l["publish.missing_item"], { template: String(i.params?.template ?? ""), locales: ([] as string[]).concat((i.params?.locales as string[] | undefined) ?? []).join(", ") })}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
              {others.length ? (
                <Alert variant="destructive">
                  <AlertTitle>{l["publish.errors_title"]}</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {others.map((i, n) => (
                        <li key={n}>{`${i.path ? `${i.path}: ` : ""}${issueText(i, l)}`}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
              <FormField label={l["publish.change_note"]} hint={l["publish.change_note_hint"]}>
                <Textarea name="changeNote" rows={2} maxLength={500} />
              </FormField>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="migrateActive" className="mt-1" disabled={migratableCount === 0} data-testid="publish-migrate" />
                <span>
                  {fill(l["publish.migrate"], { count: migratableCount })}
                  <span className="block text-xs text-muted-foreground">{l["publish.migrate_hint"]}</span>
                </span>
              </label>
            </>
          )}
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {done !== null ? l["common.close"] : l["common.cancel"]}
            </Button>
            {done === null ? (
              <Button type="submit" disabled={busy || blocked} data-testid="publish-submit">
                {l["publish.submit"]}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
