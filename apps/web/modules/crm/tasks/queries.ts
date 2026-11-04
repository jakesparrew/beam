/** Task queries (crm spec 4.3), implemented by crm-P6. crm-P1 stubs. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { TaskKind, TaskPriority, TaskSource, TaskStatus } from "@beam/core/crm";

export type TaskRow = {
  id: string;
  title: string;
  kind: TaskKind;
  priority: TaskPriority;
  status: TaskStatus;
  source: TaskSource;
  dueAt: Date | null;
  isOverdue: boolean;
  isDueToday: boolean;
  owner: { id: string; name: string | null; disabled: boolean };
  personId: string | null;
  companyId: string | null;
};

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

export function listTasks(
  _tx: DbOrTx,
  _input: { userId: string; scope: "mine" | "all"; status?: TaskStatus; overdueOnly?: boolean; dueToday?: boolean; personId?: string; companyId?: string; opportunityId?: string },
): Promise<TaskRow[]> {
  return notYet("listTasks");
}

export function getTaskCounts(_tx: DbOrTx, _userId: string): Promise<{ open: number; overdue: number; dueToday: number }> {
  return notYet("getTaskCounts");
}
