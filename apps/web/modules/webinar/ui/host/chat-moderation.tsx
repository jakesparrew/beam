"use client";
/**
 * The chat stream and the questions queue of the host console (webinar spec 5.1, rules 21, 37,
 * 38, edge cases 17 and 23): each message with the viewer's first name and initial, the time,
 * and its state as text (hidden, answered, muted, blocked). Buttons: Hide / Show again, Mark
 * answered (questions), Mute / Unmute, Block / Unblock (block asks for confirmation: the viewer's
 * player stops and their chat messages are hidden). Questions are visible to hosts only.
 */
import { Badge, Button } from "@beam/ui";
import type { ModerationAction } from "@beam/core/webinar";
import { moderate } from "../../actions";

type Run = (call: () => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>) => Promise<void>;

export type HostMessage = {
  id: string;
  registrationId: string;
  name: string;
  text: string;
  /** Brussels time, formatted by the page. */
  time: string;
  mode: "live" | "replay" | "on_demand";
  hidden: boolean;
  answered: boolean;
  muted: boolean;
  blocked: boolean;
};

export type ChatModerationLabels = {
  chat: string;
  questions: string;
  noChat: string;
  noQuestions: string;
  hideMessage: string;
  unhideMessage: string;
  markAnswered: string;
  answered: string;
  hidden: string;
  mute: string;
  unmute: string;
  block: string;
  unblock: string;
  muted: string;
  blocked: string;
  confirmBlock: string;
  anonymous: string;
  modes: Record<"live" | "replay" | "on_demand", string>;
};

function MessageList(props: { webinarId: string; items: HostMessage[]; questions: boolean; empty: string; pending: boolean; labels: ChatModerationLabels; run: Run }) {
  const { webinarId, items, questions, pending, labels, run } = props;
  const act = (m: HostMessage, action: ModerationAction) => {
    if (action === "block_viewer" && !window.confirm(labels.confirmBlock)) return;
    const message = action === "hide_message" || action === "unhide_message" || action === "mark_answered";
    void run(() => moderate({ webinarId, action, registrationId: m.registrationId, ...(message ? { interactionId: m.id } : {}) }));
  };
  if (!items.length) return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  return (
    <ol className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto" tabIndex={0} aria-label={questions ? labels.questions : labels.chat}>
      {items.map((m) => (
        <li key={m.id} className={`rounded-md border border-border p-2 text-sm ${m.hidden ? "opacity-60" : ""}`} data-testid={questions ? "host-question" : "host-chat"}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{m.name || labels.anonymous}</span>
            <span className="text-xs text-muted-foreground">{m.time}</span>
            {questions ? <Badge variant="outline">{labels.modes[m.mode]}</Badge> : null}
            {m.hidden ? <Badge variant="secondary">{labels.hidden}</Badge> : null}
            {m.answered ? <Badge variant="secondary">{labels.answered}</Badge> : null}
            {m.muted ? <Badge variant="secondary">{labels.muted}</Badge> : null}
            {m.blocked ? <Badge variant="destructive">{labels.blocked}</Badge> : null}
          </div>
          <p className="mt-1 break-words">{m.text}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(m, m.hidden ? "unhide_message" : "hide_message")}>
              {m.hidden ? labels.unhideMessage : labels.hideMessage}
            </Button>
            {questions && !m.answered ? (
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(m, "mark_answered")}>
                {labels.markAnswered}
              </Button>
            ) : null}
            {!m.blocked ? (
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(m, m.muted ? "unmute_viewer" : "mute_viewer")}>
                {m.muted ? labels.unmute : labels.mute}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant={m.blocked ? "outline" : "destructive"} disabled={pending} onClick={() => act(m, m.blocked ? "unblock_viewer" : "block_viewer")}>
              {m.blocked ? labels.unblock : labels.block}
            </Button>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ChatModeration(props: { webinarId: string; chat: HostMessage[]; questions: HostMessage[]; pending: boolean; labels: ChatModerationLabels; run: Run }) {
  const { labels } = props;
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2" aria-labelledby="host-questions-title">
        <h2 id="host-questions-title" className="text-lg font-semibold">
          {labels.questions}
        </h2>
        <MessageList webinarId={props.webinarId} items={props.questions} questions empty={labels.noQuestions} pending={props.pending} labels={labels} run={props.run} />
      </section>
      <section className="flex flex-col gap-2" aria-labelledby="host-chat-title">
        <h2 id="host-chat-title" className="text-lg font-semibold">
          {labels.chat}
        </h2>
        <MessageList webinarId={props.webinarId} items={props.chat} questions={false} empty={labels.noChat} pending={props.pending} labels={labels} run={props.run} />
      </section>
    </div>
  );
}
