/** Task api (crm rules 3.42 to 3.44), implemented by crm-P6. crm-P1 stub with the final signatures. */
import type { DbOrTx, Tx } from "@beam/db";
import type { RoleKey } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import type { TaskKind, TaskPriority, TaskSource } from "@beam/core/crm";
import type { EventCtx } from "../api";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

/** `ownerRole` resolves to the first active user of that role, else the owner role holder. */
export function createTask(
  _tx: Tx,
  _ctx: EventCtx,
  _input: {
    title: string;
    kind: TaskKind;
    ownerUserId?: string;
    ownerRole?: RoleKey;
    dueAt?: Date;
    priority?: TaskPriority;
    personId?: string;
    companyId?: string;
    source: TaskSource;
    ref?: { type: string; id: string };
    notes?: string;
    dedupeKey?: string;
  },
): Promise<{ taskId: string; created: boolean }> {
  return notYet("createTask");
}

export function countOpenTasks(_tx: DbOrTx, _filter: { overdue?: boolean; kind?: TaskKind; source?: TaskSource }): Promise<number> {
  return notYet("countOpenTasks");
}
