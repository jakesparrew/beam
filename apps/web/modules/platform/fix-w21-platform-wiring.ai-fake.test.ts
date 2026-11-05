import { FAKE_CUSTOMER_REVENUE_ANSWER, FAKE_DAILY_REVENUE_ANSWER } from "@beam/integrations/anthropic/fake";
import { describe, expect, it } from "vitest";
import { DPIA_KEYS } from "../../../../packages/core/src/ops/dpia";
import type { DpiaKey } from "../../../../packages/core/src/ops/types";
import { validateAiSql } from "../../../../packages/core/src/ops/validate-ai-sql";

const noDpia = Object.fromEntries(DPIA_KEYS.map((k) => [k, false])) as Record<DpiaKey, boolean>;

describe("fix-w21-platform-wiring: the Claude fake's ai.answer_question SQL", () => {
  it("the revenue-per-customer query passes ops' validator and keeps a person_id column", () => {
    const checked = validateAiSql(FAKE_CUSTOMER_REVENUE_ANSWER.sql, { dpiaApproved: noDpia });
    expect(checked).toMatchObject({ ok: true });
    expect(FAKE_CUSTOMER_REVENUE_ANSWER.sql).toMatch(/^select o\.person_id,/);
  });

  it("the daily revenue query passes ops' validator", () => {
    expect(validateAiSql(FAKE_DAILY_REVENUE_ANSWER.sql, { dpiaApproved: noDpia })).toMatchObject({ ok: true });
  });
});
