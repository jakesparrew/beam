/**
 * ops jobs, area `imports` (ops spec 4.4, rules 42-53): `import.parse`, `import.process_chunk`,
 * `import.finalise`. Registered in `../jobs.ts` by ops-P1; ops-P4 implements the handlers here
 * and keeps their names, inputs and signatures. Until then each handler is a no-op.
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

const mode = z.enum(["dry", "run"]);

/** Key `import:<id>:<run_seq>:parse`. */
export const ImportParseInput = z.object({ importId: z.uuid(), runSeq: z.number().int().min(0) });
/** Key `import:<id>:<run_seq>:<dry|run>:chunk:<n>`. */
export const ImportProcessChunkInput = z.object({ importId: z.uuid(), runSeq: z.number().int().min(0), mode, offset: z.number().int().min(0) });
/** Key `import:<id>:<run_seq>:<dry|run>:finalise`. */
export const ImportFinaliseInput = z.object({ importId: z.uuid(), runSeq: z.number().int().min(0), mode });

export type ImportJobStubResult = { implemented: false };
const notYet = (): Promise<ImportJobStubResult> => Promise.resolve({ implemented: false });

/** Streams the parts, writes `import_rows` in batches of 500, sets `row_count`. */
export function runImportParse(_ctx: JobCtx, _input: z.infer<typeof ImportParseInput>): Promise<unknown> {
  return notYet();
}

/** Rule 51: 500 rows per chunk in its own transaction, then the next offset. */
export function runImportProcessChunk(_ctx: JobCtx, _input: z.infer<typeof ImportProcessChunkInput>): Promise<unknown> {
  return notYet();
}

/** Report, reconciliation, status, cut-over auto-ticks, stats refreshes. */
export function runImportFinalise(_ctx: JobCtx, _input: z.infer<typeof ImportFinaliseInput>): Promise<unknown> {
  return notYet();
}
