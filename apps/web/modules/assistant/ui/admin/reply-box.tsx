"use client";

/** The staff side of a conversation: reply (takes it over), hand it back to the agent, close it. */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { closeConversation, releaseConversation, replyAsStaff } from "../../actions";

export function ReplyBox({
  conversationId,
  takenOver,
  closed,
  labels,
}: {
  conversationId: string;
  takenOver: boolean;
  closed: boolean;
  labels: { reply: string; hint: string; send: string; release: string; close: string };
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error?.message ?? "error");
      else router.refresh();
    });

  return (
    <div className="grid gap-3">
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!body.trim()) return;
          run(async () => {
            const r = await replyAsStaff({ conversationId, body });
            if (r.ok) setBody("");
            return r;
          });
        }}
      >
        <label htmlFor="staff-reply" className="text-sm font-semibold">
          {labels.reply}
        </label>
        <textarea
          id="staff-reply"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={4000}
          className="rounded-xl border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">{labels.hint}</p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending || !body.trim()} className="rounded-full bg-[#212842] px-5 py-2 text-sm font-semibold text-[#fffaef] disabled:opacity-50">
            {labels.send}
          </button>
          {takenOver ? (
            <button type="button" disabled={pending} onClick={() => run(() => releaseConversation({ conversationId }))} className="rounded-full border px-4 py-2 text-sm hover:bg-accent">
              {labels.release}
            </button>
          ) : null}
          {!closed ? (
            <button type="button" disabled={pending} onClick={() => run(() => closeConversation({ conversationId }))} className="rounded-full border px-4 py-2 text-sm hover:bg-accent">
              {labels.close}
            </button>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </form>
    </div>
  );
}
