/**
 * One opportunity on the pipeline board (crm spec 5.1): company, title, value, probability,
 * expected close, owner avatar, next action, last contact and a stalled badge. The page formats
 * every value on the server, so this component only lays them out. Draggable inside the board.
 */
import Link from "next/link";
import { Avatar, AvatarFallback, Badge } from "@beam/ui";

export type CardView = {
  id: string;
  version: number;
  stage: string;
  companyName: string;
  title: string;
  value: string;
  probability: string;
  expectedClose: string | null;
  ownerName: string | null;
  ownerInitials: string;
  nextAction: string | null;
  lastContact: string | null;
  isStalled: boolean;
  hasContact: boolean;
  /** The stages this card may move to (rule 3.47), computed on the server. */
  allowed: string[];
};

export type CardLabels = {
  expectedClose: string;
  lastContact: string;
  never: string;
  nextAction: string;
  stalled: string;
  noContact: string;
  move: string;
};

export function OpportunityCard({
  card,
  labels,
  onMove,
  onDragStart,
}: {
  card: CardView;
  labels: CardLabels;
  onMove?: (card: CardView) => void;
  onDragStart?: (card: CardView) => void;
}) {
  return (
    <article
      draggable={!!onDragStart}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.(card);
      }}
      className="grid gap-2 rounded-md border bg-card p-3 text-sm shadow-xs"
      aria-label={`${card.companyName}: ${card.title}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{card.companyName}</p>
          <Link href={`/admin/pipeline/${card.id}`} className="font-medium underline-offset-4 hover:underline">
            {card.title}
          </Link>
        </div>
        <Avatar className="size-7 shrink-0" title={card.ownerName ?? undefined}>
          <AvatarFallback className="text-xs">{card.ownerInitials}</AvatarFallback>
        </Avatar>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold tabular-nums">{card.value}</span>
        <Badge variant="outline" className="tabular-nums">
          {card.probability}
        </Badge>
        {card.isStalled ? <Badge variant="destructive">{labels.stalled}</Badge> : null}
        {!card.hasContact ? <Badge variant="secondary">{labels.noContact}</Badge> : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {card.expectedClose ? (
          <>
            <dt>{labels.expectedClose}</dt>
            <dd>{card.expectedClose}</dd>
          </>
        ) : null}
        {card.nextAction ? (
          <>
            <dt>{labels.nextAction}</dt>
            <dd className="truncate">{card.nextAction}</dd>
          </>
        ) : null}
        <dt>{labels.lastContact}</dt>
        <dd>{card.lastContact ?? labels.never}</dd>
      </dl>
      {onMove ? (
        <button type="button" onClick={() => onMove(card)} className="justify-self-start text-xs font-medium text-primary underline-offset-4 hover:underline">
          {labels.move}
        </button>
      ) : null}
    </article>
  );
}
